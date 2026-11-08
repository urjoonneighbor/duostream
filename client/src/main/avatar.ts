/**
 * Своя аватарка: выбор файла, проверка и хранение в <userData>/avatar/ (переживает перезапуск).
 * Тип определяется только по содержимому файла (сигнатуре), расширение роли не играет: SVG и всё, чего нет
 * в белом списке, отклоняется. Запись атомарная — временный файл, затем переименование, так что при сбое
 * остаётся прежняя аватарка, а не половина новой.
 *
 * Выбор — в два шага: pick читает и проверяет файл и держит его в памяти как ожидающий (прежняя аватарка не
 * тронута), commit записывает его вместе с кадрированием, cancelPick забывает. Кадрирование файл не меняет
 * (GIF и видео перекодировать нечем) и лежит рядом с ним отдельным файлом вместе с hash файла: кадр от другой
 * картинки (сбой между двумя записями) считается отсутствующим.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';
import { log } from './logger.ts';
import type { AvatarCrop, AvatarFile, AvatarMime, Result } from '../shared/duo-api';

/** Предел файла; то же число — AVATAR_MAX_BYTES в src/renderer/js/avatar.ts */
const MAX_BYTES = 16 * 1024 * 1024;
const FILE_NAME = 'avatar.bin';
const CROP_NAME = 'crop.json';
const BAD_FORMAT = 'Этот файл не подойдёт: нужны PNG, JPEG, WebP, GIF, MP4 или WebM (формат определяется по содержимому файла)';

export const hasAscii = (b: Uint8Array, at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/**
 * MIME по сигнатуре или null. Та же проверка — sniffAvatarMime в src/renderer/js/avatar.ts: там проверяются
 * данные от собеседника, а общего для обоих процессов кода в сборке нет.
 */
export function sniffMime(b: Uint8Array): AvatarMime | null {
  if (b.length < 16) return null;
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (hasAscii(b, 0, 'GIF87a') || hasAscii(b, 0, 'GIF89a')) return 'image/gif';
  if (hasAscii(b, 0, 'RIFF') && hasAscii(b, 8, 'WEBP')) return 'image/webp';
  if (hasAscii(b, 4, 'ftyp')) {
    // В контейнер ISO кладут ещё и картинки (HEIC, AVIF) и MOV — это не video/mp4
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    return ['heic', 'heix', 'mif1', 'msf1', 'avif', 'avis', 'qt  '].includes(brand) ? null : 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // EBML — и WebM, и Matroska; нужен DocType (элемент 0x4282) со значением «webm»
    for (let i = 4; i < Math.min(b.length, 128); i++) {
      if (b[i] !== 0x42 || b[i + 1] !== 0x82) continue;
      for (let at = i + 3; at <= i + 10; at++) if (hasAscii(b, at, 'webm')) return 'video/webm';
    }
  }
  return null;
}

/** Текст ошибки для окна: у системных ошибок сообщение английское, показываем её код */
export function errorText(err: unknown): string {
  const { code, message } = err as NodeJS.ErrnoException;
  return code ? `Не удалось прочитать или сохранить файл (${code})` : message;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Кадрирование в пределах; всё, что им не является, — по умолчанию. Та же проверка — normalizeAvatarCrop в src/renderer/js/avatar.ts */
function normalizeCrop(value: unknown): AvatarCrop {
  const { x, y, zoom } = (value ?? {}) as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(zoom)) return { x: 50, y: 50, zoom: 1 };
  return { x: clamp(x, 0, 100), y: clamp(y, 0, 100), zoom: clamp(zoom, 1, 4) };
}

const hashOf = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Читает файл, не загружая в память лишнего: размер проверяется до чтения */
export async function readLimited(file: string, maxBytes = MAX_BYTES): Promise<Buffer> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Это не файл');
    const tooLarge = (bytes: number) => new Error(`Файл слишком большой (${(bytes / 1024 / 1024).toFixed(1)} МБ), предел — ${maxBytes / 1024 / 1024} МБ`);
    if (stat.size > maxBytes) throw tooLarge(stat.size);
    const data = await handle.readFile();
    if (data.length > maxBytes) throw tooLarge(data.length); // файл вырос, пока его открывали
    return data;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Запись через временный файл: при сбое остаётся прежнее содержимое */
export async function writeFileAtomic(dir: string, name: string, data: Buffer): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  // Остатки записи, прерванной сбоем
  for (const name of await fs.promises.readdir(dir)) {
    if (name.endsWith('.tmp')) await fs.promises.rm(path.join(dir, name), { force: true }).catch(() => {});
  }
  const tmp = path.join(dir, `${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await fs.promises.open(tmp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmp, path.join(dir, name));
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export class AvatarStore {
  private readonly dirOf: () => string;
  private picking = false;
  /** Выбранный файл, который ждёт подтверждения из редактора кадра */
  private pending: Buffer | null = null;
  /** Запись, чтение и удаление — по очереди */
  private queue: Promise<unknown> = Promise.resolve();

  /** @param dirOf папка аватарки */
  constructor(dirOf: () => string) {
    this.dirOf = dirOf;
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => {});
    return run;
  }

  private get file(): string {
    return path.join(this.dirOf(), FILE_NAME);
  }

  private get cropFile(): string {
    return path.join(this.dirOf(), CROP_NAME);
  }

  /** Диалог выбора файла; avatar: null — выбор отменён. Файл становится ожидающим, текущая аватарка не меняется */
  async pick(parent: BrowserWindow | null): Promise<Result<{ avatar: AvatarFile | null }>> {
    if (this.picking) return { ok: true, avatar: null };
    this.picking = true;
    this.pending = null;
    try {
      const options: OpenDialogOptions = {
        title: 'Выберите аватарку',
        properties: ['openFile'],
        filters: [{ name: 'Картинки, GIF и видео', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm'] }],
      };
      const { canceled, filePaths } = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
      if (canceled || !filePaths[0]) return { ok: true, avatar: null };
      const data = await readLimited(filePaths[0]);
      const mime = sniffMime(data);
      if (!mime) return { ok: false, error: BAD_FORMAT };
      this.pending = data;
      return { ok: true, avatar: { mime, data, hash: hashOf(data), crop: normalizeCrop(null) } };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    } finally {
      this.picking = false;
    }
  }

  /** Ожидающий файл становится аватаркой с этим кадрированием */
  async commit(crop: unknown): Promise<Result<object>> {
    const data = this.pending;
    this.pending = null;
    if (!data) return { ok: false, error: 'Выбранный файл уже забыт, выберите его заново' };
    try {
      await this.exclusive(async () => {
        await this.writeAtomic(FILE_NAME, data);
        // Файл уже заменён: сбой здесь не отменяет выбор, в худшем случае после перезапуска кадр будет по умолчанию
        await this.writeCrop(crop, hashOf(data)).catch((err: Error) => log.warn('avatar', 'не удалось сохранить кадрирование:', err.message));
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  /** Редактор кадра закрыт отменой */
  cancelPick(): void {
    this.pending = null;
  }

  /** Новое кадрирование текущей аватарки; файл не трогает */
  async setCrop(crop: unknown): Promise<Result<object>> {
    try {
      await this.exclusive(async () => {
        await this.writeCrop(crop, hashOf(await readLimited(this.file)));
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  /** Текущая аватарка или null. Файл, который не прошёл проверку, считается отсутствующим */
  get(): Promise<AvatarFile | null> {
    return this.exclusive(async () => {
      let data: Buffer;
      try {
        data = await readLimited(this.file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('avatar', 'не удалось прочитать аватарку:', (err as Error).message);
        return null;
      }
      const mime = sniffMime(data);
      if (!mime) {
        log.warn('avatar', 'файл аватарки повреждён: неизвестная сигнатура');
        return null;
      }
      const hash = hashOf(data);
      return { mime, data, hash, crop: await this.readCrop(hash) };
    });
  }

  async remove(): Promise<Result<object>> {
    try {
      await this.exclusive(async () => {
        await fs.promises.rm(this.file, { force: true });
        await fs.promises.rm(this.cropFile, { force: true });
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  /** Отсутствующий, битый или относящийся к другому файлу кадр — по умолчанию */
  private async readCrop(hash: string): Promise<AvatarCrop> {
    try {
      const saved = JSON.parse(await fs.promises.readFile(this.cropFile, 'utf8')) as { hash?: unknown } | null;
      return normalizeCrop(saved?.hash === hash ? saved : null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('avatar', 'файл кадрирования не прочитан:', (err as Error).message);
      return normalizeCrop(null);
    }
  }

  private writeCrop(crop: unknown, hash: string): Promise<void> {
    return this.writeAtomic(CROP_NAME, Buffer.from(JSON.stringify({ ...normalizeCrop(crop), hash })));
  }

  private writeAtomic(name: string, data: Buffer): Promise<void> {
    return writeFileAtomic(this.dirOf(), name, data);
  }
}
