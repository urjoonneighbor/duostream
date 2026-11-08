/**
 * Свои реакции: выбор файлов, проверка и хранение в <userData>/reactions/ (переживают перезапуск).
 * Файлы лежат под именем hash содержимого, список — в index.json, запись атомарная. Битый индекс приложение не
 * роняет: файл откладывается в сторону, список начинается заново, а файлы реакций остаются на диске, пока отложенный индекс лежит рядом.
 *
 * Тип определяется только по сигнатуре, расширение роли не играет: SVG и всё, чего нет в белом списке, отклоняется.
 * Как у аватарки, выбор — в два шага: файлы проверяются и ждут в памяти главного процесса, create записывает их
 * с названием и выбранным звуком, cancelPick забывает.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { log } from './logger.ts';
import { errorText, hasAscii, readLimited, sniffMime, writeFileAtomic } from './avatar.ts';
import type { AvatarMime, CustomReaction, ReactionCreate, ReactionPickedFile, ReactionSoundMime, ReactionSoundRef, Result } from '../shared/duo-api';

// Те же числа — REACTION_MEDIA_MAX, REACTION_SOUND_MAX и REACTION_NAME_MAX в src/renderer/js/reactions.ts
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_SOUND_BYTES = 2 * 1024 * 1024;
const MAX_NAME_CHARS = 32;
const MAX_REACTIONS = 50;
const MAX_THUMB_CHARS = 256_000; // маленькая картинка для списка; индекс не должен разрастаться
const INDEX_NAME = 'index.json';
const BROKEN_INDEX_NAME = 'index.broken.json';
const BAD_MEDIA = 'Этот файл не подойдёт: нужны PNG, JPEG, WebP, GIF, MP4 или WebM (формат определяется по содержимому файла)';
const BAD_SOUND = 'Этот файл не подойдёт: нужны MP3, OGG, WAV, M4A, WebM или FLAC (формат определяется по содержимому файла)';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const FILE_PATTERN = /^[0-9a-f]{64}\.bin$/;
const THUMB_PATTERN = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const MEDIA_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'] satisfies AvatarMime[];
const SOUND_MIMES: readonly string[] = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/webm'] satisfies ReactionSoundMime[];

/** Сигнатура звука. Та же проверка — sniffSoundMime в src/renderer/js/reactions.ts */
function sniffSoundMime(b: Uint8Array): ReactionSoundMime | null {
  if (b.length < 16) return null;
  if (hasAscii(b, 0, 'ID3')) return 'audio/mpeg';
  // Кадр MPEG: 11 единичных бит, версия и слой не зарезервированные (у AAC ADTS слой нулевой, у JPEG сигнатура другая)
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x18) !== 0x08 && (b[1] & 0x06) !== 0) return 'audio/mpeg';
  if (hasAscii(b, 0, 'OggS')) return 'audio/ogg';
  if (hasAscii(b, 0, 'fLaC')) return 'audio/flac';
  if (hasAscii(b, 0, 'RIFF') && hasAscii(b, 8, 'WAVE')) return 'audio/wav';
  const container = sniffMime(b); // M4A и WebM — те же контейнеры, что и у видео
  if (container === 'video/mp4') return 'audio/mp4';
  if (container === 'video/webm') return 'audio/webm';
  return null;
}

/** Без управляющих и невидимых символов (ZWJ оставляем — из него собираются эмодзи), обрезка по символам, а не по UTF-16 */
function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return [...value.replace(/(?!‍)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()].slice(0, MAX_NAME_CHARS).join('').trim();
}

const hashOf = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const isSize = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) <= max;
const fileName = (hash: string) => `${hash}.bin`;

/** Запись индекса в проверенный вид; всё, что им не является, — null */
function parseItem(raw: unknown): CustomReaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = cleanName(r.name);
  if (typeof r.id !== 'string' || !HASH_PATTERN.test(r.id) || !name || !MEDIA_MIMES.includes(r.mime as string) || !isSize(r.size, MAX_MEDIA_BYTES)) return null;
  let sound: ReactionSoundRef | null = null;
  const s = r.sound as Record<string, unknown> | null | undefined;
  if (s?.kind === 'video' && String(r.mime).startsWith('video/')) sound = { kind: 'video' };
  else if (s?.kind === 'file' && typeof s.hash === 'string' && HASH_PATTERN.test(s.hash) && SOUND_MIMES.includes(s.mime as string) && isSize(s.size, MAX_SOUND_BYTES)) {
    sound = { kind: 'file', hash: s.hash, mime: s.mime as ReactionSoundMime, size: s.size };
  }
  const thumb = typeof r.thumb === 'string' && r.thumb.length <= MAX_THUMB_CHARS && THUMB_PATTERN.test(r.thumb) ? r.thumb : null;
  return { id: r.id, name, mime: r.mime as AvatarMime, size: r.size, sound, thumb };
}

interface Pending {
  data: Buffer;
  hash: string;
  mime: string;
}

export class ReactionStore {
  private readonly dirOf: () => string;
  private items: CustomReaction[] | null = null;
  private picking = false;
  private pendingMedia: Pending | null = null;
  private pendingSound: Pending | null = null;
  /** Запись, чтение и удаление — по очереди */
  private queue: Promise<unknown> = Promise.resolve();

  /** @param dirOf папка реакций */
  constructor(dirOf: () => string) {
    this.dirOf = dirOf;
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => {});
    return run;
  }

  private path(name: string): string {
    return path.join(this.dirOf(), name);
  }

  /** Индекс один раз за запуск. Вызывается только внутри exclusive */
  private async load(): Promise<CustomReaction[]> {
    if (this.items) return this.items;
    let raw: string | null = null;
    try {
      raw = await fs.promises.readFile(this.path(INDEX_NAME), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Файл занят или недоступен — это не «реакций нет»: иначе следующая запись затрёт индекс, а очистка удалит файлы
        log.warn('reactions', 'индекс не прочитан:', (err as Error).message);
        throw err;
      }
    }
    let parsed: unknown = [];
    let intact = true;
    if (raw !== null) {
      try {
        parsed = (JSON.parse(raw) as { items?: unknown } | null)?.items;
        if (!Array.isArray(parsed)) throw new Error('нет списка реакций');
      } catch (err) {
        intact = false;
        parsed = [];
        log.warn('reactions', 'индекс повреждён, список начинается заново:', (err as Error).message);
        await fs.promises.rename(this.path(INDEX_NAME), this.path(BROKEN_INDEX_NAME)).catch(() => {});
      }
    }
    const seen = new Set<string>();
    const items: CustomReaction[] = [];
    for (const entry of parsed as unknown[]) {
      const item = parseItem(entry);
      if (!item || seen.has(item.id) || items.length >= MAX_REACTIONS) continue;
      seen.add(item.id);
      if (!(await this.fileExists(item.id))) continue; // файл удалили руками — реакции нет
      if (item.sound?.kind === 'file' && !(await this.fileExists(item.sound.hash))) item.sound = null;
      items.push(item);
    }
    this.items = items;
    // Отсутствие индекса — не разрешение удалять, а отложенный битый индекс ссылается на файлы, которых нет в новом
    if (intact && raw !== null && !(await this.pathExists(BROKEN_INDEX_NAME))) await this.removeOrphans(items);
    return items;
  }

  private fileExists(hash: string): Promise<boolean> {
    return this.pathExists(fileName(hash));
  }

  private pathExists(name: string): Promise<boolean> {
    return fs.promises.access(this.path(name)).then(
      () => true,
      () => false,
    );
  }

  /** Файлы без записи в индексе — остатки сбоя между записью файла и индекса. При битом индексе не трогаем: там всё ещё нужные реакции */
  private async removeOrphans(items: CustomReaction[]): Promise<void> {
    const names = await fs.promises.readdir(this.dirOf()).catch((): string[] => []);
    const used = this.referenced(items);
    for (const name of names) {
      if (FILE_PATTERN.test(name) && !used.has(name)) await fs.promises.rm(this.path(name), { force: true }).catch(() => {});
    }
  }

  private referenced(items: CustomReaction[]): Set<string> {
    const used = new Set<string>();
    for (const item of items) {
      used.add(fileName(item.id));
      if (item.sound?.kind === 'file') used.add(fileName(item.sound.hash));
    }
    return used;
  }

  private writeIndex(items: CustomReaction[]): Promise<void> {
    return writeFileAtomic(this.dirOf(), INDEX_NAME, Buffer.from(JSON.stringify({ version: 1, items })));
  }

  list(): Promise<CustomReaction[]> {
    return this.exclusive(() => this.load());
  }

  private async pick(parent: BrowserWindow | null, options: OpenDialogOptions, maxBytes: number, sniff: (data: Buffer) => string | null, badFormat: string): Promise<Result<{ file: (ReactionPickedFile & Pending) | null }>> {
    if (this.picking) return { ok: true, file: null };
    this.picking = true;
    try {
      const { canceled, filePaths } = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
      if (canceled || !filePaths[0]) return { ok: true, file: null };
      const data = await readLimited(filePaths[0], maxBytes);
      const mime = sniff(data);
      if (!mime) return { ok: false, error: badFormat };
      return { ok: true, file: { mime, data, hash: hashOf(data), size: data.length, name: cleanName(path.parse(filePaths[0]).name) } };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    } finally {
      this.picking = false;
    }
  }

  /** Диалог выбора картинки или видео; file: null — выбор отменён. Файл ждёт create. */
  async pickMedia(parent: BrowserWindow | null): Promise<Result<{ file: ReactionPickedFile | null }>> {
    const result = await this.pick(
      parent,
      { title: 'Картинка, GIF или видео для реакции', properties: ['openFile'], filters: [{ name: 'Картинки, GIF и видео', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm'] }] },
      MAX_MEDIA_BYTES,
      sniffMime,
      BAD_MEDIA,
    );
    if (result.ok && result.file) {
      this.pendingMedia = result.file;
      this.pendingSound = null; // звук выбирается к конкретному файлу заново
    }
    return result;
  }

  /** Диалог выбора звука; file: null — выбор отменён */
  async pickSound(parent: BrowserWindow | null): Promise<Result<{ file: ReactionPickedFile | null }>> {
    const result = await this.pick(
      parent,
      { title: 'Звук для реакции', properties: ['openFile'], filters: [{ name: 'Звук', extensions: ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'mp4', 'webm', 'flac'] }] },
      MAX_SOUND_BYTES,
      sniffSoundMime,
      BAD_SOUND,
    );
    if (result.ok && result.file) this.pendingSound = result.file;
    return result;
  }

  /** Форму создания сбросили или закрыли */
  cancelPick(): void {
    this.pendingMedia = null;
    this.pendingSound = null;
  }

  /** Ожидающие файлы становятся реакцией */
  async create(input: unknown): Promise<Result<{ reaction: CustomReaction }>> {
    const { name: rawName, soundMode, thumb: rawThumb } = (input ?? {}) as Partial<ReactionCreate>;
    const media = this.pendingMedia;
    if (!media) return { ok: false, error: 'Выбранный файл уже забыт, выберите его заново' };
    const name = cleanName(rawName);
    if (!name) return { ok: false, error: 'Введите название реакции' };
    const soundFile = soundMode === 'file' ? this.pendingSound : null;
    if (soundMode === 'file' && !soundFile) return { ok: false, error: 'Выберите файл со звуком' };
    if (soundMode === 'video' && !media.mime.startsWith('video/')) return { ok: false, error: 'Звук можно взять только из видео' };
    let sound: ReactionSoundRef | null = null;
    if (soundFile) sound = { kind: 'file', hash: soundFile.hash, mime: soundFile.mime as ReactionSoundMime, size: soundFile.data.length };
    else if (soundMode === 'video') sound = { kind: 'video' };
    const thumb = typeof rawThumb === 'string' && rawThumb.length <= MAX_THUMB_CHARS && THUMB_PATTERN.test(rawThumb) ? rawThumb : null;
    try {
      return await this.exclusive(async (): Promise<Result<{ reaction: CustomReaction }>> => {
        const items = await this.load();
        if (items.length >= MAX_REACTIONS) return { ok: false, error: `Не больше ${MAX_REACTIONS} своих реакций: удалите лишние` };
        if (items.some((item) => item.id === media.hash)) return { ok: false, error: 'Реакция с этим файлом уже есть' };
        await writeFileAtomic(this.dirOf(), fileName(media.hash), media.data);
        if (soundFile) await writeFileAtomic(this.dirOf(), fileName(soundFile.hash), soundFile.data);
        const reaction: CustomReaction = { id: media.hash, name, mime: media.mime as AvatarMime, size: media.data.length, sound, thumb };
        const next = [...items, reaction];
        await this.writeIndex(next);
        this.items = next;
        this.pendingMedia = null;
        this.pendingSound = null;
        return { ok: true, reaction };
      });
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  /** Сначала индекс, потом файлы: при сбое останутся лишние файлы, а не запись без файла */
  async remove(id: unknown): Promise<Result<object>> {
    if (typeof id !== 'string' || !HASH_PATTERN.test(id)) return { ok: false, error: 'Неизвестная реакция' };
    try {
      await this.exclusive(async () => {
        const items = await this.load();
        const removed = items.find((item) => item.id === id);
        if (!removed) return;
        const next = items.filter((item) => item !== removed);
        await this.writeIndex(next);
        this.items = next;
        const used = this.referenced(next);
        const files = [id, ...(removed.sound?.kind === 'file' ? [removed.sound.hash] : [])].map(fileName);
        for (const name of files) if (!used.has(name)) await fs.promises.rm(this.path(name), { force: true }).catch(() => {});
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  /** Файл реакции (картинка, видео или звук) по hash или null. Только файлы из индекса; испорченный считается отсутствующим */
  read(hash: unknown): Promise<Uint8Array | null> {
    return this.exclusive(async () => {
      if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) return null;
      const items = await this.load();
      const asMedia = items.find((item) => item.id === hash);
      const asSound = items.find((item) => item.sound?.kind === 'file' && item.sound.hash === hash);
      if (!asMedia && !asSound) return null;
      let data: Buffer;
      try {
        data = await readLimited(this.path(fileName(hash)), asMedia ? MAX_MEDIA_BYTES : MAX_SOUND_BYTES);
      } catch (err) {
        log.warn('reactions', 'файл реакции не прочитан:', (err as Error).message);
        return null;
      }
      const type = asMedia ? sniffMime(data) : sniffSoundMime(data);
      if (hashOf(data) !== hash || !type) {
        log.warn('reactions', 'файл реакции повреждён');
        return null;
      }
      return data;
    });
  }
}
