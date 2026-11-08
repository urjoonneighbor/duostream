// Обмен аватарками с собеседником — по каналу чата (js/chat.ts, сообщения avatar-*). Старая версия приложения
// неизвестные сообщения просто пропускает.
//
//   avatar-offer {hash, mime, size, crop} — «у меня такая аватарка» (hash: null — аватарку убрали). Уходит при открытии
//                                     каналов (сессия WebRTC пересоздаётся), при смене своей аватарки и её кадрирования:
//                                     тот же hash с другим crop файл заново не передаёт. crop нет (старая версия) — по умолчанию.
//   avatar-want  {hash}             — «пришли»: только если такого hash ещё нет в кэше памяти.
//   avatar-chunk {hash, seq, data}  — кусок в base64.
//
// Отправка уступает дорогу: большой файл не держит в очереди канала больше ~200 КБ, чтобы обычные сообщения не
// залипали за ним. Данные от собеседника недоверенные: белый список типов, предел размера, строгий порядок и
// размер кусков, сигнатура, SHA-256 против заявленного hash. Только проверенное становится Blob и blob: URL.

import { Emitter } from './events.ts';
import { fromBase64, sha256Hex, toBase64, waitDrain } from './channel-transfer.ts';
import { AVATAR_MAX_BYTES, AvatarMedia, avatarFitsResolution, isAvatarMime, normalizeAvatarCrop, sameAvatarCrop, sniffAvatarMime } from './avatar.ts';
import type { AvatarCrop, AvatarFile, AvatarMime } from '../../shared/duo-api';

export type AvatarWho = 'me' | 'peer';

const CHUNK = 48 * 1024;
const MAX_CHUNK_BASE64 = Math.ceil(CHUNK / 3) * 4;
const HIGH_WATER = 128 * 1024; // сообщение чата встанет в очередь максимум за столько данных
const LOW_WATER = 64 * 1024;

const IDLE_TIMEOUT_MS = 20_000; // куски перестали приходить
const TOTAL_TIMEOUT_MS = 5 * 60_000; // 16 МБ даже на медленном аплоаде столько не идут
const MAX_FAILURES = 3; // после стольких сбоев на одних каналах перестаём просить
const RECEIVE_BUDGET = 128 * 1024 * 1024; // всего принять за жизнь каналов: защита от бесконечной смены аватарок
const MAX_SENDS = 8; // сколько раз отдать одну аватарку на одних каналах
const OFFER_INTERVAL_MS = 2000; // чаще предложения собеседника не применяем: смена файла пересоздаёт видео и кружки чата
const CACHE_ITEMS = 4;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

interface Inbound {
  hash: string;
  mime: AvatarMime;
  size: number;
  /** Кадрирование из последнего предложения: может смениться, пока файл идёт */
  crop: AvatarCrop;
  nextSeq: number;
  received: number;
  /** Всё принято, идут проверки: новые куски не нужны */
  complete: boolean;
  chunks: Uint8Array<ArrayBuffer>[];
  startedAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
}

export class AvatarSync extends Emitter<{ change: { who: AvatarWho } }> {
  /** Своя и собеседника; удерживаются, пока текущие (см. AvatarMedia) */
  me: AvatarMedia | null = null;
  peer: AvatarMedia | null = null;
  private channel: RTCDataChannel | null = null;
  /** Метка текущей отправки: другая метка — отправку прервали */
  private sending: object | null = null;
  private sendsLeft = MAX_SENDS;
  private inbound: Inbound | null = null;
  private failures = 0;
  private budget = RECEIVE_BUDGET;
  /** Предложение пришло раньше, чем у нас открылись оба канала чата: разберём его в open() */
  private earlyOffer: Record<string, unknown> | null = null;
  private lastOfferAt = -Infinity;
  /** Последнее из предложений, пришедших чаще OFFER_INTERVAL_MS */
  private pendingOffer: Record<string, unknown> | null = null;
  private offerTimer: ReturnType<typeof setTimeout> | null = null;
  private posterBusy = false;
  /** Принятые аватарки по hash: при пересоздании сессии повторно не гоняем */
  private readonly cache = new Map<string, AvatarMedia>();

  // ---------------- своя аватарка ----------------

  /** Новая своя аватарка или null: прерывает старую отправку и сообщает собеседнику */
  setOwn(file: AvatarFile | null): void {
    if (file?.hash === this.me?.hash) {
      if (file) this.setOwnCrop(file.crop); // тот же файл, но кадр мог стать другим
      return;
    }
    this.sending = null;
    this.sendsLeft = MAX_SENDS;
    this.replace('me', file ? new AvatarMedia(new Blob([file.data as BlobPart], { type: file.mime }), file.mime, file.hash, normalizeAvatarCrop(file.crop)) : null);
    this.sendOffer();
  }

  /** Новое кадрирование своей аватарки: файл заново не передаётся, идущая отправка не прерывается */
  setOwnCrop(crop: AvatarCrop): void {
    if (this.me && this.updateCrop('me', this.me, normalizeAvatarCrop(crop))) this.sendOffer();
  }

  /** true — кадрирование изменилось */
  private updateCrop(who: AvatarWho, media: AvatarMedia, crop: AvatarCrop): boolean {
    if (sameAvatarCrop(media.crop, crop)) return false;
    media.crop = crop;
    this.emit('change', { who });
    return true;
  }

  private sendOffer(): void {
    const me = this.me;
    this.send(me ? { t: 'avatar-offer', hash: me.hash, mime: me.mime, size: me.blob.size, crop: me.crop } : { t: 'avatar-offer', hash: null });
  }

  private send(msg: object): void {
    try {
      this.channel?.send(JSON.stringify(msg));
    } catch {
      // канал закрывается — предложим заново на следующем
    }
  }

  private replace(who: AvatarWho, media: AvatarMedia | null): void {
    const old = this[who];
    if (old === media) return;
    media?.retain();
    this[who] = media;
    this.emit('change', { who }); // подписчики заменяют элементы — старый URL больше никому не нужен
    old?.release();
    this.capturePosters();
  }

  /** Постеры снимаются по одному и только для текущих аватарок: каждый снимок — скрытое видео с декодером */
  private capturePosters(): void {
    if (this.posterBusy) return;
    const who = (['me', 'peer'] as const).find((w) => this[w]?.needsPoster);
    const media = who && this[who];
    if (!who || !media) return;
    this.posterBusy = true;
    void media.capturePoster().then((poster) => {
      this.posterBusy = false;
      if (poster && this[who] === media) this.emit('change', { who });
      this.capturePosters();
    });
  }

  // ---------------- каналы ----------------

  /** Каналы открылись: заново обо всём договариваемся */
  open(channel: RTCDataChannel): void {
    if (this.channel === channel) return; // оба канала могут открыться в одном такте
    this.closeTransfers();
    this.channel = channel;
    this.failures = 0;
    this.sendsLeft = MAX_SENDS;
    this.budget = RECEIVE_BUDGET;
    channel.bufferedAmountLowThreshold = LOW_WATER;
    this.sendOffer();
    const early = this.earlyOffer;
    this.earlyOffer = null;
    if (early) this.throttleOffer(early);
  }

  /** Каналы закрылись: незавершённое отбрасываем, показанная аватарка остаётся */
  close(): void {
    this.channel = null;
    this.earlyOffer = null;
    this.closeTransfers();
  }

  private closeTransfers(): void {
    this.sending = null;
    this.dropPendingOffer();
    this.dropInbound();
  }

  /** Собеседник ушёл или сменился: его аватарка не должна остаться показанной для другого человека */
  resetPeer(): void {
    this.earlyOffer = null;
    this.dropPendingOffer();
    this.dropInbound();
    this.replace('peer', null);
  }

  /** Сообщение канала; true — это наше (avatar-*), остальное обрабатывает чат */
  handle(msg: Record<string, unknown>): boolean {
    if (msg.t === 'avatar-offer') {
      if (this.channel) this.throttleOffer(msg);
      else this.earlyOffer = msg; // у собеседника каналы открылись раньше: ответить пока нечем
    } else if (msg.t === 'avatar-want') this.onWant(msg);
    else if (msg.t === 'avatar-chunk') this.onChunk(msg);
    else return false;
    return true;
  }

  // ---------------- отправка ----------------

  private onWant(msg: Record<string, unknown>): void {
    const me = this.me;
    if (!me || msg.hash !== me.hash || this.sending || this.sendsLeft <= 0) return;
    this.sendsLeft--;
    void this.pump(me);
  }

  private async pump(media: AvatarMedia): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    const token = (this.sending = {});
    const alive = () => this.sending === token && this.channel === channel && channel.readyState === 'open';
    const { blob, hash } = media;
    try {
      for (let seq = 0, offset = 0; offset < blob.size; seq++, offset += CHUNK) {
        while (alive() && channel.bufferedAmount > HIGH_WATER) await waitDrain(channel);
        if (!alive()) return;
        const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
        if (!alive()) return;
        channel.send(JSON.stringify({ t: 'avatar-chunk', hash, seq, data: toBase64(bytes) }));
      }
    } catch (err) {
      console.warn('[avatar] отправка прервалась:', (err as Error).message);
    } finally {
      if (this.sending === token) this.sending = null;
    }
  }

  // ---------------- приём ----------------

  /** Предложения применяются не чаще OFFER_INTERVAL_MS, из накопившихся — только последнее */
  private throttleOffer(msg: Record<string, unknown>): void {
    if (this.offerTimer) {
      this.pendingOffer = msg;
      return;
    }
    const wait = this.lastOfferAt + OFFER_INTERVAL_MS - performance.now();
    if (wait <= 0) {
      this.lastOfferAt = performance.now();
      this.onOffer(msg);
      return;
    }
    this.pendingOffer = msg;
    this.offerTimer = setTimeout(() => {
      const pending = this.pendingOffer;
      this.offerTimer = null;
      this.pendingOffer = null;
      if (pending) this.throttleOffer(pending);
    }, wait);
  }

  private dropPendingOffer(): void {
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offerTimer = null;
    this.pendingOffer = null;
  }

  private onOffer(msg: Record<string, unknown>): void {
    if (msg.hash === null) {
      this.dropInbound();
      this.replace('peer', null);
      return;
    }
    const { hash, mime, size } = msg;
    if (typeof hash !== 'string' || !HASH_PATTERN.test(hash) || !isAvatarMime(mime)) return;
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > AVATAR_MAX_BYTES) return;
    const crop = normalizeAvatarCrop(msg.crop); // от собеседника: только конечные числа в пределах
    if (this.inbound?.hash === hash) {
      this.inbound.crop = crop;
      return;
    }
    this.dropInbound(); // новая аватарка (или возврат к показанной) отменяет недокачанную
    if (this.peer?.hash === hash) {
      this.updateCrop('peer', this.peer, crop);
      return;
    }
    const cached = this.cache.get(hash);
    if (cached) {
      this.cache.delete(hash);
      this.cache.set(hash, cached); // самая свежая — в конец
      cached.crop = crop;
      this.replace('peer', cached);
      return;
    }
    if (this.failures >= MAX_FAILURES || this.budget <= 0) return;
    this.inbound = { hash, mime, size, crop, nextSeq: 0, received: 0, complete: false, chunks: [], startedAt: performance.now(), idleTimer: this.armIdle(hash) };
    this.send({ t: 'avatar-want', hash });
  }

  private armIdle(hash: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (this.inbound?.hash === hash) this.fail('собеседник перестал присылать данные');
    }, IDLE_TIMEOUT_MS);
  }

  private dropInbound(): void {
    if (this.inbound) clearTimeout(this.inbound.idleTimer);
    this.inbound = null;
  }

  private fail(reason: string): void {
    this.failures++;
    this.dropInbound();
    console.warn(`[avatar] аватарка собеседника отклонена: ${reason}`);
  }

  private onChunk(msg: Record<string, unknown>): void {
    const inbound = this.inbound;
    if (!inbound || msg.hash !== inbound.hash || inbound.complete) return; // остатки прерванной передачи или лишнее после последнего куска
    if (msg.seq !== inbound.nextSeq) return this.fail('нарушен порядок кусков');
    if (typeof msg.data !== 'string' || msg.data.length > MAX_CHUNK_BASE64) return this.fail('неверный кусок');
    if (performance.now() - inbound.startedAt > TOTAL_TIMEOUT_MS) return this.fail('передача затянулась');
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = fromBase64(msg.data);
    } catch {
      return this.fail('неверный base64');
    }
    // Куски строго по CHUNK, кроме последнего: их число и суммарный объём заранее известны
    if (bytes.length !== Math.min(CHUNK, inbound.size - inbound.received)) return this.fail('неверный размер куска');
    // Первый кусок содержит всю сигнатуру: чужой формат отсекается до накопления
    if (inbound.nextSeq === 0 && sniffAvatarMime(bytes) !== inbound.mime) return this.fail('содержимое не совпало с заявленным типом');
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
    // Сжатый файл мал, а развернуться может в гигабайты: размер кадра проверяем до показа
    const fits = await avatarFitsResolution(blob, inbound.mime);
    if (this.inbound !== inbound) return;
    if (!fits) return this.fail('слишком большое разрешение или файл не читается');
    this.dropInbound();
    const media = new AvatarMedia(blob, inbound.mime, inbound.hash, inbound.crop);
    this.remember(media);
    this.replace('peer', media);
  }

  /** Кэш ограничен: вытесняем самые старые из тех, что сейчас не показаны */
  private remember(media: AvatarMedia): void {
    this.cache.set(media.hash, media);
    for (const [hash, old] of this.cache) {
      if (this.cache.size <= CACHE_ITEMS) break;
      if (!old.inUse && old !== media) this.cache.delete(hash);
    }
  }
}
