// Клиент сигнального сервера: вход по паролю (challenge–response), автопереподключение,
// подпись и проверка каждого сигнального сообщения HMAC-ом общего пароля.
import { deriveKey, hmacHex, hmacVerify, authMessage, signalMessage } from './crypto.js';

const PROTOCOL_VERSION = 1;
const OTHER = { streamer: 'viewer', viewer: 'streamer' };
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;
// После этих ошибок переподключаться бессмысленно
const FATAL = new Set(['auth-failed', 'banned', 'replaced', 'bad-version', 'bad-role']);

export class SignalingClient extends EventTarget {
  /** Обработчик входящих сигналов; вызывается строго по порядку, следующий ждёт предыдущий */
  onSignal = null;

  constructor({ url, password, role, name }) {
    super();
    this.url = url;
    this.password = password;
    this.role = role;
    this.name = name;
    this.ws = null;
    this.key = null;
    this.state = 'idle';
    this.retry = 0;
    this.closedByUser = false;
    this.fatal = null;
    this.sendChain = Promise.resolve(true);
    this.recvChain = Promise.resolve();
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(state, info = {}) {
    this.state = state;
    this.emit('state', { state, ...info });
  }

  async connect() {
    this.closedByUser = false;
    this.setState('connecting');
    this.key ??= await deriveKey(this.password);
    this.open();
  }

  open() {
    clearTimeout(this.retryTimer);
    if (this.closedByUser) return;
    if (this.retry === 0) this.setState('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.setState('failed', { message: `Некорректный адрес сервера: ${err.message}` });
      return;
    }
    this.ws = ws;
    this.fatal = null;
    ws.onmessage = (event) => this.onMessage(ws, event.data);
    ws.onclose = (event) => this.onClose(ws, event);
  }

  async onMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'challenge': {
        const proof = await hmacHex(this.key, authMessage(msg.nonce, this.role));
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
      case 'signal':
        this.recvChain = this.recvChain.then(() => this.receiveSignal(msg)).catch((err) => console.error('[signal]', err));
        break;
      case 'error':
        if (FATAL.has(msg.code)) this.fatal = msg;
        this.emit('server-error', { code: msg.code, message: msg.message });
        break;
      default:
        break;
    }
  }

  async receiveSignal(msg) {
    const from = OTHER[this.role];
    const valid =
      msg.from === from &&
      typeof msg.payload === 'string' &&
      (await hmacVerify(this.key, signalMessage(from, msg.ts, msg.payload), msg.sig));
    if (!valid) {
      this.emit('server-error', {
        code: 'bad-signature',
        message: 'Сигнальное сообщение не прошло проверку подписи: у собеседника другой пароль или данные подменены',
      });
      return;
    }
    if (Math.abs(Date.now() - msg.ts) > MAX_CLOCK_SKEW_MS) {
      this.emit('server-error', {
        code: 'clock-skew',
        message: 'Часы на компьютерах расходятся больше чем на 15 минут — включите синхронизацию времени в Windows',
      });
      return;
    }
    await this.onSignal?.(JSON.parse(msg.payload));
  }

  /** Подписывает и отправляет сигнальное сообщение второму участнику (с сохранением порядка). */
  sendSignal(obj) {
    const payload = JSON.stringify(obj);
    this.sendChain = this.sendChain
      .then(async () => {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN || this.state !== 'open') return false;
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

  onClose(ws, event) {
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

  close() {
    this.closedByUser = true;
    clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close(1000);
    else this.setState('closed');
  }
}
