// Библиотека реакций (свои и собеседника) и обмен файлами своих реакций — по каналу чата (js/chat.ts, сообщения
// reaction-*). Старая версия приложения неизвестные сообщения просто пропускает.
//
//   reaction-desc {id, name, mime, size, sound} — описание: уходит при первом использовании реакции в этой сессии.
//                                     id — hash файла; sound: null, {kind:'video'} или {kind:'file', hash, mime, size}.
//   reaction-want {hash}             — «пришли»: только то, чего нет в кэше памяти.
//   reaction-gone {hash}             — «этого нет»: получатель не ждёт таймаута.
//   reaction-cancel {hash}           — «пока не надо»: нужнее звук, большой файл попросим заново после него.
//   reaction-chunk {hash, seq, data} — кусок в base64.
//
// Реакция применяется сразу, пока файла нет — показывается заглушка с именем. Файлы идут по одному, и отправка уступает
// дорогу сильнее, чем у аватарки: в очереди канала не больше одного куска, так что сообщения чата и аватарки не
// застревают за реакцией. Данные от собеседника недоверенные: белый список типов, предел размера до накопления, строгий
// порядок и размер кусков, сигнатура, SHA-256, частота описаний; имя — только как текст. Кэш ограничен объёмом.

import { Emitter } from './events.ts';
import { AvatarMedia, DEFAULT_AVATAR_CROP, isAvatarMime, sniffAvatarMime } from './avatar.ts';
import { fromBase64, sha256Hex, toBase64, waitDrain } from './channel-transfer.ts';
import { RateWindow, REACTION_MEDIA_MAX, REACTION_SOUND_MAX, isCustomReactionKey, isReactionSoundMime, makeReactionThumb, reactionFitsResolution, sanitizeReactionName, sniffSoundMime } from './reactions.ts';
import type { ReactionSound } from './reaction-sound.ts';
import type { AvatarMime, CustomReaction, ReactionSoundMime, ReactionSoundRef } from '../../shared/duo-api';

const CHUNK = 48 * 1024;
const MAX_CHUNK_BASE64 = Math.ceil(CHUNK / 3) * 4;
const HIGH_WATER = 64 * 1024; // у аватарки 128 КБ: реакция пропускает её и сообщения чата вперёд
const LOW_WATER = 64 * 1024;

const IDLE_TIMEOUT_MS = 20_000;
const TOTAL_TIMEOUT_MS = 3 * 60_000;
const RECEIVE_BUDGET = 128 * 1024 * 1024; // всего принять за жизнь каналов
const SEND_BUDGET = 256 * 1024 * 1024; // всего отдать за жизнь каналов
const MAX_FAILURES = 8; // после стольких сбоев на одних каналах перестаём просить
const MAX_HASH_FAILURES = 2;
const MAX_SENDS_PER_FILE = 6;
const MAX_WANTED = 128; // 50 своих реакций собеседника, у каждой картинка и звук
const MAX_OUTBOUND = 16;
const MAX_PEER_INFOS = 256;
// Отдельно по видам: пачка больших видео не вытесняет маленькие звуки
const CACHE_BYTES: Record<FileKind, number> = { media: 96 * 1024 * 1024, sound: 24 * 1024 * 1024 };
const PENDING_SOUND_MS = 5000; // звук, пришедший позже реакции: дольше ждать незачем
const MAX_PENDING_SOUNDS = 8;
const PEER_DESCS = 64; // описаний за 5 с: больше, чем своих реакций у честного собеседника (50), — сброс очереди после обрыва проходит целиком
const PREEMPT_MIN_LEFT = 256 * 1024; // звук не перебивает передачу, которой осталось меньше

/** Реакция, которую можно показать: своя (файл на диске) или описанная собеседником */
export interface ReactionInfo extends CustomReaction {
  /** Файл есть у нас: своя реакция */
  own: boolean;
}

type FileKind = 'media' | 'sound';

interface CachedFile {
  kind: FileKind;
  blob: Blob;
  /** Только у картинки или видео реакции; звук — просто байты */
  media: AvatarMedia | null;
}

/** Ключ кэша: один и тот же файл как звук и как картинка реакции — разные записи, проверенные каждая по своему */
const slot = (kind: FileKind, hash: string) => `${kind}:${hash}`;

interface WantedFile {
  key: string;
  hash: string;
  kind: FileKind;
  mime: AvatarMime | ReactionSoundMime;
  size: number;
}

interface Inbound extends WantedFile {
  nextSeq: number;
  received: number;
  complete: boolean;
  chunks: Uint8Array<ArrayBuffer>[];
  startedAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
}

const validSize = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 16 && value <= max;

/** Описание звука от собеседника; undefined — неверное */
function parseSound(raw: unknown, mime: AvatarMime): ReactionSoundRef | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (s.kind === 'video') return mime.startsWith('video/') ? { kind: 'video' } : undefined;
  if (s.kind === 'file' && isCustomReactionKey(s.hash) && isReactionSoundMime(s.mime) && validSize(s.size, REACTION_SOUND_MAX)) return { kind: 'file', hash: s.hash, mime: s.mime, size: s.size };
  return undefined;
}

export class ReactionSync extends Emitter<{ change: { key: string | null } }> {
  private readonly infos = new Map<string, ReactionInfo>();
  /** Файлы в памяти по slot, порядок — от давних к свежим */
  private readonly files = new Map<string, CachedFile>();
  private readonly cachedBytes: Record<FileKind, number> = { media: 0, sound: 0 };
  private readonly loading = new Map<string, Promise<CachedFile | null>>();
  private player: ReactionSound | null = null;
  private channel: RTCDataChannel | null = null;
  /** Какие свои реакции уже описаны на этих каналах */
  private readonly described = new Set<string>();
  private wanted: WantedFile[] = [];
  private inbound: Inbound | null = null;
  private failures = 0;
  private readonly hashFailures = new Map<string, number>();
  private budget = RECEIVE_BUDGET;
  private sendBudget = SEND_BUDGET;
  private readonly sends = new Map<string, number>();
  private outbound: string[] = [];
  private sending: object | null = null;
  private sendingHash: string | null = null;
  private cancelledHash: string | null = null;
  private readonly descRate = new RateWindow(PEER_DESCS, 5000);
  private readonly wantRate = new RateWindow(60, 5000);
  /** Реакции, чей звук ещё в пути; slot — какого файла ждём */
  private pendingSounds: { key: string; slot: string; at: number }[] = [];
  private thumbChain: Promise<unknown> = Promise.resolve();

  attachSound(player: ReactionSound): void {
    this.player = player;
  }

  // ---------------- свои реакции ----------------

  setOwn(list: CustomReaction[]): void {
    for (const reaction of list) this.infos.set(reaction.id, { ...reaction, own: true });
    this.emit('change', { key: null });
  }

  addOwn(reaction: CustomReaction): void {
    this.infos.set(reaction.id, { ...reaction, own: true });
    this.emit('change', { key: null });
  }

  /** Описание остаётся: чипы под старыми сообщениями показывают ту же картинку, пока живёт чат */
  removeOwn(id: string): void {
    const info = this.infos.get(id);
    if (info) info.own = false;
    this.described.delete(id);
    this.emit('change', { key: null });
  }

  get ownList(): ReactionInfo[] {
    return [...this.infos.values()].filter((info) => info.own);
  }

  info(key: string): ReactionInfo | null {
    return this.infos.get(key) ?? null;
  }

  /** Подпись для уведомления и оверлея: эмодзи или имя */
  label(key: string): string {
    if (!isCustomReactionKey(key)) return key;
    return this.infos.get(key)?.name ?? 'реакция';
  }

  /** Картинка реакции, если файл уже в памяти */
  media(key: string): AvatarMedia | null {
    return this.files.get(slot('media', key))?.media ?? null;
  }

  /** Что показать в маленьком чипе: у видео и у всего чужого статичная картинка, свои GIF и картинка как есть; null — заглушка с именем */
  thumbSrc(key: string): string | null {
    const info = this.infos.get(key);
    if (!info) return null;
    if (!info.own || info.mime.startsWith('video/')) return info.thumb; // чужой GIF на каждый чип — лишние декодеры; живьём он только всплывает
    return this.media(key)?.url || info.thumb;
  }

  /** Перед показом: подгрузить файл реакции. Своя читается с диска, чужая просится у собеседника */
  async ensureMedia(key: string): Promise<AvatarMedia | null> {
    const info = this.infos.get(key);
    if (!info) return null;
    return (await this.file(key, info.id, 'media', info.mime, info.size))?.media ?? null;
  }

  // ---------------- файлы в памяти ----------------

  private async file(key: string, hash: string, kind: FileKind, mime: AvatarMime | ReactionSoundMime, size: number): Promise<CachedFile | null> {
    const fileSlot = slot(kind, hash);
    const cached = this.files.get(fileSlot);
    if (cached) {
      this.files.delete(fileSlot);
      this.files.set(fileSlot, cached); // самый свежий — в конец
      return cached;
    }
    if (!this.infos.get(key)?.own) {
      this.want({ key, hash, kind, mime, size });
      return null;
    }
    let job = this.loading.get(fileSlot);
    if (!job) {
      job = this.readOwn(hash, kind, mime).finally(() => this.loading.delete(fileSlot));
      this.loading.set(fileSlot, job);
    }
    return job;
  }

  private async readOwn(hash: string, kind: FileKind, mime: string): Promise<CachedFile | null> {
    try {
      const data = await window.duo.reactions.read(hash);
      if (!data) return null;
      const file = this.makeFile(new Blob([data as BlobPart], { type: mime }), kind, mime, hash);
      this.remember(hash, file);
      if (file.media) this.emit('change', { key: hash }); // чипы заменят статичную картинку на GIF
      return file;
    } catch (err) {
      console.warn('[reactions] файл не прочитан:', (err as Error).message);
      return null;
    }
  }

  private makeFile(blob: Blob, kind: FileKind, mime: string, hash: string): CachedFile {
    const media = kind === 'media' ? new AvatarMedia(blob, mime as AvatarMime, hash, DEFAULT_AVATAR_CROP) : null;
    media?.retain(); // адрес живёт, пока файл в кэше
    return { kind, blob, media };
  }

  /** Кэш ограничен объёмом: вытесняются давние. Чипы при этом падают на статичную картинку, живые элементы держат свои ссылки */
  private remember(hash: string, file: CachedFile): void {
    const { kind } = file;
    const fileSlot = slot(kind, hash);
    const previous = this.files.get(fileSlot);
    if (previous) {
      this.cachedBytes[kind] -= previous.blob.size;
      previous.media?.release();
    }
    this.files.set(fileSlot, file);
    this.cachedBytes[kind] += file.blob.size;
    for (const [oldSlot, old] of this.files) {
      if (this.cachedBytes[kind] <= CACHE_BYTES[kind]) break;
      if (oldSlot === fileSlot || old.kind !== kind) continue;
      this.files.delete(oldSlot);
      this.cachedBytes[kind] -= old.blob.size;
      if (old.media) {
        this.emit('change', { key: old.media.hash });
        old.media.release();
      }
    }
  }

  // ---------------- звук ----------------

  /** Звук реакции. remote — поставил собеседник: действуют пределы частоты */
  playSound(key: string, remote: boolean): void {
    const info = this.infos.get(key);
    if (info?.sound && this.player?.enabled) void this.startSound(info, remote, false);
  }

  /** Кнопка «Прослушать» в настройках */
  previewSound(key: string): void {
    const info = this.infos.get(key);
    if (info?.sound) void this.startSound(info, false, true);
  }

  private async startSound(info: ReactionInfo, remote: boolean, preview: boolean): Promise<void> {
    const sound = info.sound;
    if (!sound) return;
    const kind: FileKind = sound.kind === 'video' ? 'media' : 'sound';
    const id = sound.kind === 'video' ? info.id : sound.hash;
    // Своя реакция: готовому буферу файл не нужен, даже если его вытеснили из кэша
    const decoded = info.own && Boolean(this.player?.isDecoded(id));
    const file = decoded ? null : sound.kind === 'video' ? await this.file(info.id, info.id, 'media', info.mime, info.size) : await this.file(info.id, sound.hash, 'sound', sound.mime, sound.size);
    if (!file && !decoded) {
      if (remote) this.addPendingSound(info.id, slot(kind, id)); // сыграем, когда файл дойдёт
      return;
    }
    await this.player?.play(id, file?.blob ?? null, { remote, preview, untrusted: !info.own });
  }

  private addPendingSound(key: string, fileSlot: string): void {
    const pending = this.pendingSounds.filter((p) => p.key !== key);
    pending.push({ key, slot: fileSlot, at: performance.now() });
    this.pendingSounds = pending.slice(-MAX_PENDING_SOUNDS);
  }

  /** Файл дошёл: реакции, ждавшие его как звук, играют сейчас. Один файл — один раз, даже если его ждали несколько реакций */
  private flushPendingSounds(fileSlot: string): void {
    const now = performance.now();
    const fresh = this.pendingSounds.filter((p) => now - p.at <= PENDING_SOUND_MS);
    this.pendingSounds = fresh.filter((p) => p.slot !== fileSlot);
    const ready = fresh.filter((p) => p.slot === fileSlot).pop();
    if (ready) this.playSound(ready.key, true);
  }

  // ---------------- каналы ----------------

  open(channel: RTCDataChannel): void {
    if (this.channel === channel) return;
    this.closeTransfers();
    this.channel = channel;
    this.failures = 0;
    this.hashFailures.clear();
    this.sends.clear();
    this.described.clear();
    this.budget = RECEIVE_BUDGET;
    this.sendBudget = SEND_BUDGET;
    channel.bufferedAmountLowThreshold = LOW_WATER;
    this.startNext();
  }

  close(): void {
    this.channel = null;
    this.closeTransfers();
  }

  /** Недокачанное возвращается в очередь: на новых каналах попросим заново */
  private closeTransfers(): void {
    this.sending = null;
    this.sendingHash = null;
    this.cancelledHash = null;
    this.outbound = [];
    const inbound = this.inbound;
    if (inbound) {
      this.dropInbound();
      this.wanted.unshift({ key: inbound.key, hash: inbound.hash, kind: inbound.kind, mime: inbound.mime, size: inbound.size });
    }
  }

  /** Собеседник ушёл или сменился: его описания остаются для истории чата, запросы — нет */
  resetPeer(): void {
    this.dropInbound();
    this.wanted = [];
    this.pendingSounds = [];
  }

  /** Каналы открылись: файлы реакций под сообщениями, которые так и не дошли, просим заново — заглушка не должна оставаться навсегда */
  requestMissing(keys: Iterable<string>): void {
    for (const key of keys) {
      const info = this.infos.get(key);
      if (info && !info.own && !info.thumb && !this.files.has(slot('media', key))) this.requestFiles(key); // со статичной картинкой заглушки нет: вытесненное заново не качаем
    }
  }

  /** Сообщение канала; true — это наше (reaction-desc/want/gone/cancel/chunk) */
  handle(msg: Record<string, unknown>): boolean {
    if (msg.t === 'reaction-desc') this.onDesc(msg);
    else if (msg.t === 'reaction-want') this.onWant(msg);
    else if (msg.t === 'reaction-gone') this.onGone(msg);
    else if (msg.t === 'reaction-cancel') this.onCancel(msg);
    else if (msg.t === 'reaction-chunk') this.onChunk(msg);
    else return false;
    return true;
  }

  private send(msg: object): void {
    try {
      this.channel?.send(JSON.stringify(msg));
    } catch {
      // канал закрывается — обо всём договоримся на следующем
    }
  }

  // ---------------- описание своих реакций ----------------

  /** Перед первым использованием своей реакции на этих каналах: собеседник узнаёт имя, тип и звук */
  announce(key: string): void {
    const info = this.infos.get(key);
    if (!info?.own || !this.channel || this.described.has(key)) return;
    this.described.add(key);
    this.send({ t: 'reaction-desc', id: info.id, name: info.name, mime: info.mime, size: info.size, sound: info.sound });
  }

  private onDesc(msg: Record<string, unknown>): void {
    if (!this.descRate.allow()) return;
    const { id, mime, size } = msg;
    if (!isCustomReactionKey(id) || !isAvatarMime(mime) || !validSize(size, REACTION_MEDIA_MAX)) return;
    const sound = parseSound(msg.sound, mime);
    if (sound === undefined) return;
    const known = this.infos.get(id);
    if (known?.own) return; // такая реакция есть и у нас
    if (known && (known.mime !== mime || known.size !== size)) return;
    const name = sanitizeReactionName(msg.name);
    if (known) {
      known.name = name;
      known.sound = sound;
    } else {
      this.infos.set(id, { id, name, mime, size, sound, thumb: null, own: false });
      this.trimPeerInfos();
    }
    this.requestFiles(id);
    this.emit('change', { key: id });
  }

  private trimPeerInfos(): void {
    let peerCount = 0;
    for (const info of this.infos.values()) if (!info.own) peerCount++;
    for (const [key, info] of this.infos) {
      if (peerCount <= MAX_PEER_INFOS) break;
      if (info.own) continue;
      this.infos.delete(key);
      peerCount--;
    }
  }

  private requestFiles(key: string): void {
    const info = this.infos.get(key);
    if (!info) return;
    // Звук маленький и нужен сразу, при постановке, — идёт раньше картинки или видео
    if (info.sound?.kind === 'file' && this.player?.enabled) void this.file(key, info.sound.hash, 'sound', info.sound.mime, info.sound.size);
    void this.file(key, info.id, 'media', info.mime, info.size);
  }

  // ---------------- отправка ----------------

  private findOwnFile(hash: string): { key: string; kind: FileKind; mime: string; size: number } | null {
    for (const info of this.infos.values()) {
      if (!info.own) continue;
      if (info.id === hash) return { key: info.id, kind: 'media', mime: info.mime, size: info.size };
      if (info.sound?.kind === 'file' && info.sound.hash === hash) return { key: info.id, kind: 'sound', mime: info.sound.mime, size: info.sound.size };
    }
    return null;
  }

  private onWant(msg: Record<string, unknown>): void {
    const { hash } = msg;
    const inProgress = hash === this.sendingHash && hash !== this.cancelledHash;
    if (!this.wantRate.allow() || !isCustomReactionKey(hash) || inProgress || this.outbound.includes(hash)) return;
    const own = this.findOwnFile(hash);
    const sent = this.sends.get(hash) ?? 0;
    if (!own || sent >= MAX_SENDS_PER_FILE || this.outbound.length >= MAX_OUTBOUND || this.sendBudget < own.size) {
      this.send({ t: 'reaction-gone', hash });
      return;
    }
    this.sends.set(hash, sent + 1);
    this.sendBudget -= own.size;
    this.outbound.push(hash);
    void this.pump();
  }

  /** Получателю срочнее другое: текущий файл обрывается, из очереди — убирается */
  private onCancel(msg: Record<string, unknown>): void {
    const { hash } = msg;
    if (hash === this.sendingHash) this.cancelledHash = hash as string;
    else this.outbound = this.outbound.filter((queued) => queued !== hash);
  }

  private async pump(): Promise<void> {
    const channel = this.channel;
    if (!channel || this.sending) return;
    const token = (this.sending = {});
    const alive = () => this.sending === token && this.channel === channel && channel.readyState === 'open';
    try {
      while (alive() && this.outbound.length) {
        const hash = this.outbound.shift()!;
        this.sendingHash = hash;
        const own = this.findOwnFile(hash);
        const file = own ? await this.file(own.key, hash, own.kind, own.mime as AvatarMime, own.size) : null;
        if (!alive()) return;
        if (!file) {
          this.send({ t: 'reaction-gone', hash });
          continue;
        }
        const { blob } = file;
        for (let seq = 0, offset = 0; offset < blob.size; seq++, offset += CHUNK) {
          while (alive() && channel.bufferedAmount > HIGH_WATER) await waitDrain(channel);
          if (!alive()) return;
          if (this.cancelledHash === hash) break;
          const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
          if (!alive()) return;
          channel.send(JSON.stringify({ t: 'reaction-chunk', hash, seq, data: toBase64(bytes) }));
        }
        this.cancelledHash = null;
      }
    } catch (err) {
      console.warn('[reactions] отправка прервалась:', (err as Error).message);
    } finally {
      if (this.sending === token) {
        this.sending = null;
        this.sendingHash = null;
        this.cancelledHash = null;
      }
    }
  }

  // ---------------- приём ----------------

  private want(file: WantedFile): void {
    const same = (w: WantedFile) => w.hash === file.hash && w.kind === file.kind;
    if ((this.inbound && same(this.inbound)) || this.wanted.some(same)) return;
    if (this.wanted.length >= MAX_WANTED || (this.hashFailures.get(file.hash) ?? 0) >= MAX_HASH_FAILURES) return;
    if (file.kind === 'sound') {
      // Звук нужен при постановке и маленький: идёт раньше картинок и видео, в том числе уже начатых
      this.insertBeforeMedia(file);
      this.preemptMedia();
    } else {
      this.wanted.push(file);
    }
    this.startNext();
  }

  private insertBeforeMedia(file: WantedFile): void {
    const at = this.wanted.findIndex((w) => w.kind === 'media');
    this.wanted.splice(at < 0 ? this.wanted.length : at, 0, file);
  }

  /** Большой файл уступает звуку: начнётся заново сразу после него. Объём приёма не возвращается: иначе собеседник мог бы гонять файлы без предела, подсовывая новые звуки */
  private preemptMedia(): void {
    const inbound = this.inbound;
    if (!inbound || inbound.kind !== 'media' || inbound.complete || inbound.size - inbound.received < PREEMPT_MIN_LEFT) return;
    this.send({ t: 'reaction-cancel', hash: inbound.hash });
    this.dropInbound();
    this.insertBeforeMedia({ key: inbound.key, hash: inbound.hash, kind: inbound.kind, mime: inbound.mime, size: inbound.size });
  }

  /** Файлы — строго по одному: куски не перемешиваются, и размер накопления известен заранее */
  private startNext(): void {
    if (this.inbound || !this.channel || this.failures >= MAX_FAILURES || this.budget <= 0) return;
    const next = this.wanted.shift();
    if (!next) return;
    if (this.files.has(slot(next.kind, next.hash))) return this.startNext();
    this.inbound = { ...next, nextSeq: 0, received: 0, complete: false, chunks: [], startedAt: performance.now(), idleTimer: this.armIdle(next.hash) };
    this.send({ t: 'reaction-want', hash: next.hash });
  }

  private armIdle(hash: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (this.inbound?.hash === hash) this.fail('собеседник перестал присылать данные', true);
    }, IDLE_TIMEOUT_MS);
  }

  private dropInbound(): void {
    if (this.inbound) clearTimeout(this.inbound.idleTimer);
    this.inbound = null;
  }

  /** @param retry сбой случайный (связь, таймаут): файл просим ещё раз, пока не исчерпан MAX_HASH_FAILURES */
  private fail(reason: string, retry = false): void {
    const inbound = this.inbound;
    this.failures++;
    if (inbound) {
      const count = (this.hashFailures.get(inbound.hash) ?? 0) + 1;
      this.hashFailures.set(inbound.hash, count);
      if (retry && count < MAX_HASH_FAILURES && this.wanted.length < MAX_WANTED) this.wanted.push({ key: inbound.key, hash: inbound.hash, kind: inbound.kind, mime: inbound.mime, size: inbound.size });
    }
    this.dropInbound();
    console.warn(`[reactions] файл реакции отклонён: ${reason}`);
    this.startNext();
  }

  private onGone(msg: Record<string, unknown>): void {
    if (!this.inbound || msg.hash !== this.inbound.hash) return;
    // Не нарушение: это обычный ответ, например новому собеседнику про реакции из истории. На этих каналах файл больше не просим
    this.hashFailures.set(this.inbound.hash, MAX_HASH_FAILURES);
    this.dropInbound();
    this.startNext();
  }

  private onChunk(msg: Record<string, unknown>): void {
    const inbound = this.inbound;
    if (!inbound || msg.hash !== inbound.hash || inbound.complete) return;
    if (msg.seq !== inbound.nextSeq) return this.fail('нарушен порядок кусков');
    if (typeof msg.data !== 'string' || msg.data.length > MAX_CHUNK_BASE64) return this.fail('неверный кусок');
    if (performance.now() - inbound.startedAt > TOTAL_TIMEOUT_MS) return this.fail('передача затянулась', true);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = fromBase64(msg.data);
    } catch {
      return this.fail('неверный base64');
    }
    if (bytes.length !== Math.min(CHUNK, inbound.size - inbound.received)) return this.fail('неверный размер куска');
    // Первый кусок содержит всю сигнатуру: чужой формат отсекается до накопления
    if (inbound.nextSeq === 0 && (inbound.kind === 'media' ? sniffAvatarMime(bytes) : sniffSoundMime(bytes)) !== inbound.mime) return this.fail('содержимое не совпало с заявленным типом');
    this.budget -= bytes.length;
    if (this.budget < 0) return this.fail('превышен общий объём');
    inbound.chunks.push(bytes);
    inbound.received += bytes.length;
    inbound.nextSeq++;
    clearTimeout(inbound.idleTimer);
    inbound.idleTimer = this.armIdle(inbound.hash);
    if (inbound.received !== inbound.size) return;
    inbound.complete = true; // finish запускается ровно один раз
    void this.finish(inbound);
  }

  private async finish(inbound: Inbound): Promise<void> {
    const bytes = new Uint8Array(inbound.size);
    let at = 0;
    for (const chunk of inbound.chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    inbound.chunks = [];
    const hash = await sha256Hex(bytes);
    if (this.inbound !== inbound) return; // за время проверки передачу отменили или собеседник ушёл
    if (hash !== inbound.hash) return this.fail('SHA-256 не совпал с заявленным');
    const blob = new Blob([bytes], { type: inbound.mime });
    if (inbound.kind === 'media' && !(await reactionFitsResolution(blob, inbound.mime as AvatarMime))) {
      if (this.inbound === inbound) this.fail('слишком большое разрешение или файл не читается');
      return;
    }
    if (this.inbound !== inbound) return;
    this.dropInbound();
    const file = this.makeFile(blob, inbound.kind, inbound.mime, inbound.hash);
    this.remember(inbound.hash, file);
    if (file.media) this.queueThumb(inbound.key, file.media);
    this.emit('change', { key: inbound.key });
    this.flushPendingSounds(slot(inbound.kind, inbound.hash));
    this.startNext();
  }

  /** Статичная картинка для чипов: снимается по одной — у видео это скрытый декодер */
  private queueThumb(key: string, media: AvatarMedia): void {
    this.thumbChain = this.thumbChain.then(async () => {
      const info = this.infos.get(key);
      if (!info || info.thumb) return;
      info.thumb = await makeReactionThumb(media);
      if (info.thumb) this.emit('change', { key });
    });
  }
}
