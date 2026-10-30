// Клиент сигнального сервера: вход по паролю (challenge–response), автопереподключение,
// подпись и проверка каждого сигнального сообщения HMAC-ом общего пароля.
import { deriveKey, hmacHex, hmacVerify, authMessage, signalMessage } from './crypto.ts';
import { Emitter } from './events.ts';
import type { Role } from '../../shared/config';

const PROTOCOL_VERSION = 1;
const OTHER: Record<Role, Role> = { streamer: 'viewer', viewer: 'streamer' };
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;
// После этих ошибок переподключаться бессмысленно
const FATAL = new Set(['auth-failed', 'banned', 'replaced', 'bad-version', 'bad-role']);

/** Второй участник так, как его описывает сервер */
export interface PeerInfo {
  role: Role;
  name: string;
  ip?: string;
}

export type SignalingState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed';

export interface SignalingEvents {
  state: { state: SignalingState; code?: string; message?: string; delay?: number };
  welcome: { peer: PeerInfo | null };
  'peer-joined': { peer: PeerInfo };
  'peer-left': { role: Role };
  'server-error': { code: string; message: string };
}

/** Сообщения сервера (server/src/server.ts) */
type ServerMessage =
  | { type: 'challenge'; nonce: string }
  | { type: 'welcome'; peer: PeerInfo | null }
  | { type: 'peer-joined'; peer: PeerInfo }
  | { type: 'peer-left'; role: Role }
  | { type: 'signal'; from: Role; payload: unknown; ts: number; sig: string }
  | { type: 'error'; code: string; message: string };

/** Сигнал от собеседника: JSON с полем kind (offer, answer, ice, presence…) */
export type Signal = { kind: string; [key: string]: unknown };

export class SignalingClient extends Emitter<SignalingEvents> {
  /** Обработчик входящих сигналов; вызывается строго по порядку, следующий ждёт предыдущий */
  onSignal: ((msg: Signal) => Promise<void> | void) | null = null;

  readonly url: string;
  private readonly password: string;
  readonly role: Role;
  private readonly name: string;
  private ws: WebSocket | null = null;
  private key: CryptoKey | null = null;
  state: SignalingState = 'idle';
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByUser = false;
  private fatal: { code: string; message: string } | null = null;
  private clockWarned = false;
  private sendChain: Promise<boolean> = Promise.resolve(true);
  private recvChain: Promise<void> = Promise.resolve();

  constructor({ url, password, role, name }: { url: string; password: string; role: Role; name: string }) {
    super();
    this.url = url;
    this.password = password;
    this.role = role;
    this.name = name;
  }

  private setState(state: SignalingState, info: Omit<SignalingEvents['state'], 'state'> = {}): void {
    this.state = state;
    this.emit('state', { state, ...info });
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    this.setState('connecting');
    this.key ??= await deriveKey(this.password);
    this.open();
  }

  private open(): void {
    clearTimeout(this.retryTimer);
    if (this.closedByUser) return;
    if (this.retry === 0) this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.setState('failed', { message: `Некорректный адрес сервера: ${(err as Error).message}` });
      return;
    }
    this.ws = ws;
    this.fatal = null;
    ws.onmessage = (event) => void this.onMessage(ws, event.data);
    ws.onclose = (event) => this.onClose(ws, event);
  }

  private async onMessage(ws: WebSocket, data: unknown): Promise<void> {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(data)) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'challenge': {
        const proof = await hmacHex(this.key!, authMessage(msg.nonce, this.role));
        ws.send(JSON.stringify({ type: 'hello', role: this.role, name: this.name, proof, version: PROTOCOL_VERSION }));
        break;
      }
      case 'welcome':
        this.retry = 0;
        this.setState('open');
        this.emit('welcome', { peer: msg.peer });
        break;
      case 'peer-joined':
        this.emit('peer-joined', { peer: msg.peer });
        break;
      case 'peer-left':
        this.emit('peer-left', { role: msg.role });
        break;
      case 'signal': {
        const signal = msg;
        this.recvChain = this.recvChain.then(() => this.receiveSignal(signal)).catch((err) => console.error('[signal]', err));
        break;
      }
      case 'error':
        if (FATAL.has(msg.code)) this.fatal = msg;
        this.emit('server-error', { code: msg.code, message: msg.message });
        break;
      default:
        break;
    }
  }

  private async receiveSignal(msg: Extract<ServerMessage, { type: 'signal' }>): Promise<void> {
    const from = OTHER[this.role];
    const valid =
      msg.from === from &&
      typeof msg.payload === 'string' &&
      (await hmacVerify(this.key!, signalMessage(from, msg.ts, msg.payload), msg.sig));
    if (!valid) {
      this.emit('server-error', {
        code: 'bad-signature',
        message: 'Сигнальное сообщение не прошло проверку подписи: у собеседника другой пароль или данные подменены',
      });
      return;
    }
    // Подлинность уже проверена подписью; неверные часы на одном из ПК не должны ломать соединение,
    // поэтому только предупреждаем (один раз)
    if (Math.abs(Date.now() - msg.ts) > MAX_CLOCK_SKEW_MS && !this.clockWarned) {
      this.clockWarned = true;
      this.emit('server-error', {
        code: 'clock-skew',
        message: 'Часы на компьютерах расходятся больше чем на 15 минут — включите синхронизацию времени в Windows',
      });
    }
    await this.onSignal?.(JSON.parse(msg.payload as string) as Signal);
  }

  /** Подписывает и отправляет сигнальное сообщение второму участнику (с сохранением порядка). */
  sendSignal(obj: Signal): Promise<boolean> {
    const payload = JSON.stringify(obj);
    this.sendChain = this.sendChain
      .then(async () => {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN || this.state !== 'open' || !this.key) return false;
        const ts = Date.now();
        const sig = await hmacHex(this.key, signalMessage(this.role, ts, payload));
        ws.send(JSON.stringify({ type: 'signal', payload, ts, sig }));
        return true;
      })
      .catch((err) => {
        console.error('[signal] send', err);
        return false;
      });
    return this.sendChain;
  }

  private onClose(ws: WebSocket, event: CloseEvent): void {
    if (ws !== this.ws) return;
    this.ws = null;
    if (this.closedByUser) {
      this.setState('closed');
      return;
    }
    if (this.fatal) {
      this.setState('failed', { code: this.fatal.code, message: this.fatal.message });
      return;
    }
    const delay = Math.min(10_000, 1000 * 2 ** this.retry++);
    this.setState('reconnecting', {
      delay,
      message: event.code === 1006 ? 'сервер недоступен' : `соединение закрыто (код ${event.code})`,
    });
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  close(): void {
    this.closedByUser = true;
    clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close(1000);
    else this.setState('closed');
  }
}
