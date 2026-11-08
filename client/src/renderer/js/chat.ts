// Чат и передача файлов любого размера — напрямую P2P, каналами данных той же WebRTC-сессии.
//
// Канал «chat» (JSON): сообщения и управление передачей. Канал «file» (двоичный): куски по 64 КБ
// с заголовком [id передачи: uint32][смещение: float64]. Файл читается с диска кусками (File.slice)
// и так же кусками пишется у получателя (src/main/downloads.ts) — в память целиком не грузится.
//
// Сессию WebRTC приложение иногда пересоздаёт (рост окна трансляции, смена кодека, обрыв сети).
// Передачи это переживают: на новых каналах получатель сообщает, сколько байт у него уже есть
// (file-accept с offset), и отправитель продолжает с этого места. Текст, набранный без связи,
// уходит, как только каналы откроются.
//
// Картинки до 25 МБ (скриншоты) показываются в чате миниатюрой: у отправителя — из самого файла,
// у получателя — из пришедших кусков (они и так проходят через интерфейс). Такие картинки получатель
// принимает сам, без «Принять», — как в мессенджерах; остальные файлы ждут согласия.

const CHUNK = 64 * 1024;
const HEADER = 12;
const HIGH_WATER = 4 * 1024 * 1024; // не держать в очереди канала больше 4 МБ
const LOW_WATER = 1024 * 1024;

const PREVIEW_MAX = 25 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

import { Emitter } from './events.ts';
import { AvatarSync } from './avatar-sync.ts';
import { ReactionSync } from './reaction-sync.ts';
import { RateWindow, REACTIONS_PER_PERSON, isReactionKey } from './reactions.ts';
import type { PeerSession } from './peer.ts';
import type { LinkPreview } from '../../shared/duo-api';

/** Кто поставил реакцию: участников двое, счётчик — 1 или 2 */
export interface ReactionMarks {
  me: boolean;
  peer: boolean;
}

export type TransferStatus = 'offered' | 'sending' | 'finishing' | 'receiving' | 'done' | 'rejected' | 'cancelled' | 'error';

export interface MessageItem {
  kind: 'msg';
  id: number;
  mine: boolean;
  text: string;
  ts: number;
  pending?: boolean;
  /** Карточка первой ссылки в тексте */
  preview?: LinkPreview;
  /** Реакции: ключ → кто поставил, в порядке появления */
  reactions?: Map<string, ReactionMarks>;
}

/** Передача файла — входящая или исходящая */
export interface Transfer {
  kind: 'file';
  id: number;
  mine: boolean;
  name: string;
  size: number;
  status: TransferStatus;
  ts: number;
  pending?: boolean;
  sent: number;
  received: number;
  /** Реакции: ключ → кто поставил, в порядке появления */
  reactions?: Map<string, ReactionMarks>;
  /** Скорость, байт/с */
  speed: number;
  speedMark: { at: number; bytes: number };
  error?: string;
  /** Миниатюра картинки (blob:) */
  preview?: string | null;
  /** Под спойлером: миниатюра скрыта, пока по ней не щёлкнут */
  spoiler?: boolean;
  /** Входящая картинка: её MIME и то, что её приняли без «Принять» */
  imageType?: string | null;
  auto?: boolean;
  // отправка
  file?: File;
  token?: object | null;
  readId?: number | null;
  // приём
  fileId?: number;
  path?: string;
  writing?: Promise<void>;
  chunks?: ArrayBuffer[] | null;
}

export type ChatItem = MessageItem | Transfer;

/** Управляющие сообщения канала «chat» */
type Control =
  | { t: 'msg'; id: number; text: string; ts: number }
  | { t: 'msg-preview'; id: number; preview: unknown }
  | { t: 'reaction'; id: number; key: string; on: boolean }
  | { t: 'file-offer'; id: number; name: string; size: number; spoiler?: boolean }
  | { t: 'file-accept'; id: number; offset: number }
  | { t: 'file-reject'; id: number }
  | { t: 'file-cancel'; id: number }
  | { t: 'file-received'; id: number };

type Channels = { chat: RTCDataChannel; file: RTCDataChannel };

/** Спойлер в тексте: ||скрытое|| (как в Discord); может занимать несколько строк */
export const SPOILER_PATTERN = /\|\|([\s\S]+?)\|\|/g;

/** Текст без содержимого спойлеров — для уведомлений, оверлея и карточки ссылки */
export function hideSpoilers(text: string): string {
  return text.replace(SPOILER_PATTERN, '▒▒▒');
}

/** Ссылки в тексте сообщения (без завершающих знаков препинания) */
export const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'«»]+[^\s<>"'«».,;:!?)\]}]/gi;

const MAX_PREVIEW_IMAGE = 200_000; // символов data: URL — сообщение канала не больше 256 КБ

/** Карточка от собеседника: только ожидаемые поля разумной длины, ссылка http(s), картинка — JPEG data: URL */
function sanitizePreview(raw: unknown): LinkPreview | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const url = text(p.url, 2048);
  const title = text(p.title, 300);
  if (!url || !/^https?:\/\//i.test(url) || !title) return null;
  const image =
    typeof p.image === 'string' && p.image.length <= MAX_PREVIEW_IMAGE && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p.image)
      ? p.image
      : undefined;
  return { url, title, site: text(p.site, 100), description: text(p.description, 400), image, video: p.video === true };
}

const randomId = () => crypto.getRandomValues(new Uint32Array(1))[0];

/** MIME картинки, которую показываем миниатюрой, по имени и размеру; иначе null */
function previewType(name: string, size: number): string | null {
  const ext = /\.(\w+)$/.exec(String(name))?.[1]?.toLowerCase() ?? '';
  return size > 0 && size <= PREVIEW_MAX ? (IMAGE_TYPES[ext] ?? null) : null;
}

const STREAM_REACTIONS_PER_SECOND = 5;
const PEER_REACTIONS = 40; // реакций на сообщения за PEER_REACTIONS_MS; что не вошло при сбросе очереди, догонит reaction-state
const PEER_REACTIONS_MS = 5000;
const PEER_REACTION_STATES = 6; // сводок за PEER_REACTIONS_MS: честный собеседник шлёт одну на каждое открытие каналов
const REACTION_STATE_ITEMS = 200; // сообщений в сводке: она не больше 256 КБ — предела сообщения канала

export interface ChatEvents {
  change: { item: ChatItem | null };
  /**
   * Реакцию на сообщение поставили или сняли.
   * silent — состояние догнали при новом открытии каналов: без звука, анимации и уведомления
   */
  reaction: { item: ChatItem; key: string; who: 'me' | 'peer'; on: boolean; silent: boolean };
  'stream-reaction': { key: string; who: 'me' | 'peer' };
}

export class Chat extends Emitter<ChatEvents> {
  /** Сообщения и передачи по порядку */
  readonly items: ChatItem[] = [];
  private readonly transfers = new Map<number, Transfer>(); // входящие и исходящие
  private outbox: Control[] = []; // сообщения, набранные без связи
  private channels: Channels | null = null; // когда оба открыты
  session: PeerSession | null = null;
  /** Аватарки ходят по этому же каналу (js/avatar-sync.ts) */
  readonly avatars = new AvatarSync();
  /** Свои реакции ходят по этому же каналу (js/reaction-sync.ts) */
  readonly reactions = new ReactionSync();
  /** Сообщения, на которых мы меняли реакции: их итог уходит сводкой при открытии каналов; порядок — от давних к свежим */
  private readonly reactedItems = new Set<number>();
  private readonly peerReactionRate = new RateWindow(PEER_REACTIONS, PEER_REACTIONS_MS);
  private readonly peerReactionStateRate = new RateWindow(PEER_REACTION_STATES, PEER_REACTIONS_MS);
  private readonly peerStreamRate = new RateWindow(STREAM_REACTIONS_PER_SECOND, 1000);
  private readonly ownStreamRate = new RateWindow(STREAM_REACTIONS_PER_SECOND, 1000);

  get connected(): boolean {
    return Boolean(this.channels);
  }

  private changed(item: ChatItem | null = null): void {
    this.emit('change', { item });
  }

  // ---------------- каналы ----------------

  /** Новая WebRTC-сессия: ждём открытия её каналов */
  attach(session: PeerSession): void {
    this.detach();
    this.session = session;
    const { chatChannel: chat, fileChannel: file } = session;
    if (!chat || !file) return;
    file.bufferedAmountLowThreshold = LOW_WATER;
    const ready = () => {
      if (this.session !== session || chat.readyState !== 'open' || file.readyState !== 'open') return;
      this.channels = { chat, file };
      this.onOpen();
    };
    chat.onopen = ready;
    file.onopen = ready;
    chat.onclose = () => this.session === session && this.detach();
    chat.onmessage = (e: MessageEvent) => this.session === session && this.onControl(e.data);
    file.onmessage = (e: MessageEvent) => this.session === session && this.onChunk(e.data);
    ready();
  }

  detach(): void {
    const was = this.connected;
    this.session = null;
    this.channels = null;
    this.avatars.close();
    this.reactions.close();
    if (was) this.changed();
  }

  private onOpen(): void {
    this.avatars.open(this.channels!.chat);
    this.reactions.open(this.channels!.chat);
    // Реакции — после сообщений и предложений файлов: иначе они придут к ещё не существующему id
    const queued = this.outbox.splice(0);
    for (const msg of queued) if (msg.t !== 'reaction' && !this.sendControl(msg)) this.outbox.push(msg);
    for (const item of this.items) if (item.pending) item.pending = false;
    for (const t of this.transfers.values()) {
      // Возобновление: получатель сообщает, сколько уже записал
      if (!t.mine && t.status === 'receiving') this.sendControl({ t: 'file-accept', id: t.id, offset: t.received });
      // Подтверждение могло потеряться при обрыве — повторяем, иначе отправитель ждёт его вечно
      if (!t.mine && t.status === 'done') this.sendControl({ t: 'file-received', id: t.id });
      // Предложение файла, которое собеседник мог не получить
      if (t.mine && t.status === 'offered') this.sendControl({ t: 'file-offer', id: t.id, name: t.name, size: t.size, spoiler: t.spoiler });
    }
    // Снятия раньше постановок: иначе у собеседника новая реакция упрётся в предел, который освободится следующим сообщением
    for (const on of [false, true]) for (const msg of queued) if (msg.t === 'reaction' && msg.on === on && !this.sendControl(msg)) this.outbox.push(msg);
    this.sendReactionState();
    this.requestMissingReactions();
    this.changed();
  }

  /**
   * Сводка своих реакций: подтверждений нет, и всё, что лежало в очереди умершего канала или не прошло пределы
   * получателя, иначе разошлось бы до конца чата. Получатель сверяет её с тем, что у него есть
   */
  private sendReactionState(): void {
    const channels = this.channels;
    if (!channels || !this.reactedItems.size || channels.chat.readyState !== 'open') return;
    const byId = new Map(this.items.map((item) => [item.id, item]));
    const items: { id: number; keys: string[] }[] = [];
    for (const id of this.reactedItems) {
      const item = byId.get(id);
      if (!item) continue;
      const keys = [...(item.reactions ?? [])].filter(([, marks]) => marks.me).map(([key]) => key);
      for (const key of keys) this.reactions.announce(key);
      items.push({ id, keys });
    }
    if (!items.length) return;
    try {
      channels.chat.send(JSON.stringify({ t: 'reaction-state', items }));
    } catch {
      // канал закрывается — сводка уйдёт на следующем
    }
  }

  /** Файлы реакций из истории, которые не дошли: новые сообщения — первыми, в очереди не всё поместится */
  private requestMissingReactions(): void {
    const keys = new Set<string>();
    for (let i = this.items.length - 1; i >= 0; i--) for (const key of this.items[i].reactions?.keys() ?? []) keys.add(key);
    this.reactions.requestMissing(keys);
  }

  private sendControl(msg: Control): boolean {
    // Канал мог начать закрываться раньше, чем пришёл onclose: send в этом состоянии бросает
    if (!this.channels || this.channels.chat.readyState !== 'open') return false;
    if (msg.t === 'reaction') this.reactions.announce(msg.key); // описание своей реакции — раньше неё
    try {
      this.channels.chat.send(JSON.stringify(msg));
    } catch {
      return false;
    }
    return true;
  }

  // ---------------- сообщения ----------------

  sendText(text: string): void {
    const value = String(text).trim();
    if (!value) return;
    const msg = { t: 'msg' as const, id: randomId(), text: value.slice(0, 20_000), ts: Date.now() };
    const item: MessageItem = { kind: 'msg', id: msg.id, mine: true, text: msg.text, ts: msg.ts, pending: !this.connected };
    this.items.push(item);
    if (!this.sendControl(msg)) this.outbox.push(msg);
    this.changed();
    void this.attachPreview(item);
  }

  /**
   * Карточка первой ссылки: страницу скачивает наше приложение (src/main/link-preview.ts), собеседнику
   * уходит готовая карточка — у него ничего не загружается
   */
  private async attachPreview(item: MessageItem): Promise<void> {
    const url = hideSpoilers(item.text).match(URL_PATTERN)?.[0]; // ссылка под спойлером карточкой не раскрывается
    if (!url) return;
    const preview = sanitizePreview(await window.duo.linkPreview(url).catch(() => null));
    if (!preview) return;
    item.preview = preview;
    this.changed(item);
    const msg: Control = { t: 'msg-preview', id: item.id, preview };
    if (!this.sendControl(msg)) this.outbox.push(msg);
  }

  private onControl(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const record = parsed as Record<string, unknown>;
    if (this.avatars.handle(record) || this.reactions.handle(record)) return;
    if (record.t === 'reaction-stream') {
      if (isReactionKey(record.key) && this.peerStreamRate.allow()) this.emit('stream-reaction', { key: record.key, who: 'peer' });
      return;
    }
    if (record.t === 'reaction-state') {
      this.onPeerReactionState(record.items);
      return;
    }
    const msg = parsed as Control;
    const t = this.transfers.get(msg.id);
    switch (msg.t) {
      case 'msg': {
        const item: MessageItem = { kind: 'msg', id: msg.id, mine: false, text: String(msg.text ?? '').slice(0, 20_000), ts: Number(msg.ts) || Date.now() };
        this.items.push(item);
        this.changed(item);
        break;
      }
      case 'msg-preview': {
        const item = this.items.find((i): i is MessageItem => i.kind === 'msg' && !i.mine && i.id === msg.id);
        const preview = sanitizePreview(msg.preview);
        if (item && preview && !item.preview) {
          item.preview = preview;
          this.changed(item);
        }
        break;
      }
      case 'reaction':
        this.onPeerReaction(msg);
        break;
      case 'file-offer':
        if (t) return; // повторное предложение после переподключения
        {
          const name = String(msg.name ?? 'файл');
          const size = Number(msg.size) || 0;
          const imageType = previewType(name, size);
          this.addTransfer({ id: msg.id, mine: false, name, size, status: 'offered', imageType, auto: Boolean(imageType), spoiler: msg.spoiler === true });
          if (imageType) void this.accept(msg.id); // картинку принимаем сразу — её покажем в чате
        }
        break;
      case 'file-accept':
        if (t?.mine && ['offered', 'sending', 'finishing'].includes(t.status)) this.startSending(t, Number(msg.offset) || 0);
        break;
      case 'file-reject':
        if (t?.mine) this.setStatus(t, 'rejected');
        break;
      case 'file-cancel':
        if (t && !['done', 'rejected', 'cancelled'].includes(t.status)) this.finishCancelled(t, 'собеседник отменил');
        break;
      case 'file-received':
        if (t?.mine) this.setStatus(t, 'done');
        break;
      default:
        break;
    }
  }

  // ---------------- реакции ----------------

  private countReactions(item: ChatItem, who: 'me' | 'peer'): number {
    let count = 0;
    for (const marks of item.reactions?.values() ?? []) if (marks[who]) count++;
    return count;
  }

  private applyReaction(item: ChatItem, key: string, who: 'me' | 'peer', on: boolean, silent = false): void {
    item.reactions ??= new Map();
    const marks = item.reactions.get(key) ?? { me: false, peer: false };
    marks[who] = on;
    if (marks.me || marks.peer) item.reactions.set(key, marks);
    else item.reactions.delete(key);
    this.emit('reaction', { item, key, who, on, silent });
  }

  /** Поставить или снять свою реакцию; false — у человека уже предел реакций на это сообщение */
  toggleReaction(id: number, key: string): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item || !isReactionKey(key)) return true;
    const on = !item.reactions?.get(key)?.me;
    if (on && this.countReactions(item, 'me') >= REACTIONS_PER_PERSON) return false;
    this.applyReaction(item, key, 'me', on);
    const msg: Control = { t: 'reaction', id, key, on };
    this.reactedItems.delete(id);
    this.reactedItems.add(id); // самое свежее — в конец
    if (this.reactedItems.size > REACTION_STATE_ITEMS) this.reactedItems.delete(this.reactedItems.values().next().value!);
    // Запись в очереди значит, что собеседник ещё видит прежнее состояние: обратное действие их взаимно отменяет
    const queued = this.outbox.findIndex((m) => m.t === 'reaction' && m.id === id && m.key === key);
    if (queued >= 0) this.outbox.splice(queued, 1);
    else if (!this.sendControl(msg)) this.outbox.push(msg);
    return true;
  }

  /** От собеседника: только к существующему сообщению, ключ из набора или формата hash, в пределах частоты и числа */
  private onPeerReaction(msg: { id: unknown; key: unknown; on: unknown }): void {
    if (typeof msg.id !== 'number' || typeof msg.on !== 'boolean' || !isReactionKey(msg.key) || !this.peerReactionRate.allow()) return;
    const item = this.items.find((i) => i.id === msg.id);
    if (!item || Boolean(item.reactions?.get(msg.key)?.peer) === msg.on) return;
    if (msg.on && this.countReactions(item, 'peer') >= REACTIONS_PER_PERSON) return;
    this.applyReaction(item, msg.key, 'peer', msg.on);
  }

  /** Сводка от собеседника: те же проверки, только расходящееся применяется, снятия — раньше постановок */
  private onPeerReactionState(raw: unknown): void {
    if (!Array.isArray(raw) || raw.length > REACTION_STATE_ITEMS || !this.peerReactionStateRate.allow()) return;
    const byId = new Map(this.items.map((item) => [item.id, item]));
    for (const entry of raw as unknown[]) {
      const { id, keys } = (entry ?? {}) as { id?: unknown; keys?: unknown };
      const item = typeof id === 'number' ? byId.get(id) : undefined;
      if (!item || !Array.isArray(keys) || keys.length > REACTIONS_PER_PERSON || !keys.every(isReactionKey)) continue;
      const wanted = new Set<string>(keys);
      for (const [key, marks] of [...(item.reactions ?? [])]) if (marks.peer && !wanted.has(key)) this.applyReaction(item, key, 'peer', false, true);
      for (const key of wanted) if (!item.reactions?.get(key)?.peer) this.applyReaction(item, key, 'peer', true, true);
    }
  }

  /** Реакция на трансляцию: живёт несколько секунд, поэтому без связи не копится */
  sendStreamReaction(key: string): boolean {
    if (!this.channels || this.channels.chat.readyState !== 'open' || !isReactionKey(key) || !this.ownStreamRate.allow()) return false;
    this.reactions.announce(key);
    this.channels.chat.send(JSON.stringify({ t: 'reaction-stream', key }));
    this.emit('stream-reaction', { key, who: 'me' });
    return true;
  }

  // ---------------- файлы: отправка ----------------

  /** @param spoiler картинка у обоих скрыта, пока по ней не щёлкнут */
  sendFiles(files: Iterable<File>, { spoiler = false } = {}): void {
    for (const file of files) {
      const preview = previewType(file.name, file.size) ? URL.createObjectURL(file) : null;
      const t = this.addTransfer({ id: randomId(), mine: true, name: file.name, size: file.size, status: 'offered', file, preview, spoiler });
      this.sendControl({ t: 'file-offer', id: t.id, name: t.name, size: t.size, spoiler });
    }
  }

  private startSending(t: Transfer, offset: number): void {
    t.sent = Math.min(Math.max(0, offset), t.size);
    this.setStatus(t, 'sending');
    void this.pump(t);
  }

  private async pump(t: Transfer): Promise<void> {
    const channels = this.channels;
    if (!channels) return;
    const token = (t.token = {});
    const alive = () => this.channels === channels && t.token === token && t.status === 'sending';
    while (t.sent < t.size) {
      if (!alive()) return;
      if (channels.file.bufferedAmount > HIGH_WATER) {
        await new Promise((resolve) => {
          channels.file.addEventListener('bufferedamountlow', resolve, { once: true });
          channels.file.addEventListener('close', resolve, { once: true });
        });
        continue;
      }
      const end = Math.min(t.size, t.sent + CHUNK);
      let data: ArrayBuffer;
      try {
        data = await this.readChunk(t, t.sent, end);
      } catch (err) {
        if (!alive()) return;
        this.sendControl({ t: 'file-cancel', id: t.id });
        this.finishCancelled(t, `не удалось прочитать файл: ${(err as Error)?.message ?? err}`);
        return;
      }
      if (!alive()) return;
      if (data.byteLength !== end - t.sent) {
        this.sendControl({ t: 'file-cancel', id: t.id });
        this.finishCancelled(t, 'файл изменился во время отправки');
        return;
      }
      const packet = new Uint8Array(HEADER + data.byteLength);
      const view = new DataView(packet.buffer);
      view.setUint32(0, t.id);
      view.setFloat64(4, t.sent);
      packet.set(new Uint8Array(data), HEADER);
      try {
        channels.file.send(packet.buffer);
      } catch {
        return; // канал закрылся — продолжим на следующем по file-accept
      }
      t.sent = end;
      this.progress(t, t.sent);
    }
    if (alive()) this.setStatus(t, 'finishing'); // всё отправлено, ждём подтверждения получателя
  }

  /**
   * Кусок файла [from, to): с диска через главный процесс (src/main/downloads.ts, Uploads) —
   * File.slice() отказывает, если файл изменился после выбора, облачный или занят другой программой.
   * Если пути на диске нет (вставка из буфера обмена), читаем через File.
   */
  private async readChunk(t: Transfer, from: number, to: number): Promise<ArrayBuffer> {
    const file = t.file!;
    if (t.readId === undefined) t.readId = await window.duo.files.openRead(file).catch(() => null);
    if (t.readId === null) return file.slice(from, to).arrayBuffer();
    const bytes = await window.duo.files.read(t.readId, from, to - from);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  private closeReader(t: Transfer): void {
    if (t.readId) window.duo.files.closeRead(t.readId).catch(() => {});
    t.readId = undefined;
  }

  // ---------------- файлы: приём ----------------

  async accept(id: number): Promise<void> {
    const t = this.transfers.get(id);
    if (!t || t.mine || t.status !== 'offered') return;
    try {
      const { id: fileId, path } = await window.duo.files.create(t.name);
      Object.assign(t, { fileId, path, received: 0, writing: Promise.resolve(), chunks: t.imageType ? [] : null });
      this.setStatus(t, 'receiving');
      this.sendControl({ t: 'file-accept', id: t.id, offset: 0 });
      if (t.size === 0) void this.completeReceive(t);
    } catch (err) {
      t.error = (err as Error).message;
      this.setStatus(t, 'error');
      this.sendControl({ t: 'file-cancel', id: t.id });
    }
  }

  reject(id: number): void {
    const t = this.transfers.get(id);
    if (!t || t.mine || t.status !== 'offered') return;
    this.setStatus(t, 'rejected');
    this.sendControl({ t: 'file-reject', id: t.id });
  }

  private onChunk(buffer: unknown): void {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER) return;
    const view = new DataView(buffer);
    const t = this.transfers.get(view.getUint32(0));
    const offset = view.getFloat64(4);
    // Только следующий по порядку кусок: остатки старого канала после возобновления пропускаем
    if (!t || t.mine || t.status !== 'receiving' || offset !== t.received) return;
    const data = buffer.slice(HEADER);
    t.received += data.byteLength;
    t.chunks?.push(data);
    const fileId = t.fileId!;
    t.writing = (t.writing ?? Promise.resolve()).then(() => window.duo.files.write(fileId, offset, data));
    t.writing.catch((err: Error) => {
      if (t.status !== 'receiving') return;
      t.error = err.message;
      this.finishCancelled(t, `ошибка записи: ${err.message}`);
    });
    this.progress(t, t.received);
    if (t.received >= t.size) void this.completeReceive(t);
  }

  private async completeReceive(t: Transfer): Promise<void> {
    try {
      await t.writing;
      await window.duo.files.close(t.fileId!);
      if (t.chunks) t.preview = URL.createObjectURL(new Blob(t.chunks, { type: t.imageType ?? '' }));
      t.chunks = null;
      this.setStatus(t, 'done');
      this.sendControl({ t: 'file-received', id: t.id });
    } catch (err) {
      t.error = (err as Error).message;
      this.setStatus(t, 'error');
    }
  }

  // ---------------- общее ----------------

  cancel(id: number): void {
    const t = this.transfers.get(id);
    if (!t || ['done', 'rejected', 'cancelled', 'error'].includes(t.status)) return;
    this.sendControl({ t: 'file-cancel', id: t.id });
    this.finishCancelled(t, 'отменено');
  }

  private finishCancelled(t: Transfer, reason: string): void {
    t.token = null;
    t.chunks = null;
    t.error = reason;
    if (!t.mine && t.fileId) void window.duo.files.abort(t.fileId); // недокачанный файл удаляем
    this.setStatus(t, 'cancelled');
  }

  reveal(id: number): void {
    const t = this.transfers.get(id);
    if (t?.path) void window.duo.files.reveal(t.path);
  }

  /** Отключились совсем: незавершённые передачи прерываем, недокачанное удаляем */
  interrupt(): void {
    for (const t of this.transfers.values()) {
      if (['offered', 'sending', 'finishing', 'receiving'].includes(t.status)) this.finishCancelled(t, 'соединение закрыто');
    }
    this.outbox = [];
    this.reactedItems.clear();
    this.avatars.resetPeer();
    this.reactions.resetPeer();
    this.detach();
  }

  private addTransfer(fields: Pick<Transfer, 'id' | 'mine' | 'name' | 'size' | 'status'> & Partial<Transfer>): Transfer {
    const t: Transfer = { kind: 'file', sent: 0, received: 0, speed: 0, ts: Date.now(), ...fields, speedMark: { at: performance.now(), bytes: 0 } };
    this.transfers.set(t.id, t);
    this.items.push(t);
    this.changed(t);
    return t;
  }

  private setStatus(t: Transfer, status: TransferStatus): void {
    t.status = status;
    if (t.mine && ['done', 'rejected', 'cancelled', 'error'].includes(status)) this.closeReader(t);
    if (status === 'done') t.speed = 0;
    this.changed(t);
  }

  /** Прогресс и скорость (обновление интерфейса — не чаще 4 раз в секунду) */
  private progress(t: Transfer, bytes: number): void {
    const now = performance.now();
    const mark = t.speedMark;
    if (now - mark.at < 250) return;
    t.speed = ((bytes - mark.bytes) * 1000) / (now - mark.at);
    t.speedMark = { at: now, bytes };
    this.changed(t);
  }
}
