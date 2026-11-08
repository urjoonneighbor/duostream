// Реакции: набор встроенных, ключи и проверка недоверенных данных. Ключ реакции — либо эмодзи из набора,
// либо hash файла своей реакции (64 hex); всё остальное от собеседника отбрасывается.
import { probeDimensions, sniffAvatarMime, type AvatarMedia } from './avatar.ts';
import type { AvatarMime, ReactionSoundMime } from '../../shared/duo-api';

export const BUILTIN_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👏', '💀', '🤡'];
const BUILTIN = new Set(BUILTIN_REACTIONS);

// Те же числа — MAX_MEDIA_BYTES, MAX_SOUND_BYTES и MAX_NAME_CHARS в src/main/reactions.ts
export const REACTION_MEDIA_MAX = 8 * 1024 * 1024;
export const REACTION_SOUND_MAX = 2 * 1024 * 1024;
export const REACTION_NAME_MAX = 32;
export const REACTION_MAX_OWN = 50;
/** Сколько реакций один человек может поставить на сообщение */
export const REACTIONS_PER_PERSON = 8;
// Реакция показывается в 18–96 px, а один кадр GIF разворачивается в полный холст: предел по стороне, а не аватарочная площадь.
// Проверяется и при создании, и при приёме от собеседника
export const REACTION_IMAGE_MAX_SIDE = 1024;
export const REACTION_VIDEO_MAX_SIDE = 1920; // живых видео единицы, и клипы обычно 1080p
const THUMB_SIDE = 128;
const SOUND_MIMES: readonly string[] = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/webm'] satisfies ReactionSoundMime[];

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export const isBuiltinReaction = (key: unknown): key is string => typeof key === 'string' && BUILTIN.has(key);
export const isCustomReactionKey = (key: unknown): key is string => typeof key === 'string' && HASH_PATTERN.test(key);
export const isReactionKey = (key: unknown): key is string => isBuiltinReaction(key) || isCustomReactionKey(key);
export const isReactionSoundMime = (mime: unknown): mime is ReactionSoundMime => typeof mime === 'string' && SOUND_MIMES.includes(mime);

const hasAscii = (b: Uint8Array, at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** Сигнатура звука. Та же проверка — sniffSoundMime в src/main/reactions.ts */
export function sniffSoundMime(b: Uint8Array): ReactionSoundMime | null {
  if (b.length < 16) return null;
  if (hasAscii(b, 0, 'ID3')) return 'audio/mpeg';
  // Кадр MPEG: 11 единичных бит, версия и слой не зарезервированные (у AAC ADTS слой нулевой, у JPEG сигнатура другая)
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x18) !== 0x08 && (b[1] & 0x06) !== 0) return 'audio/mpeg';
  if (hasAscii(b, 0, 'OggS')) return 'audio/ogg';
  if (hasAscii(b, 0, 'fLaC')) return 'audio/flac';
  if (hasAscii(b, 0, 'RIFF') && hasAscii(b, 8, 'WAVE')) return 'audio/wav';
  const container = sniffAvatarMime(b); // M4A и WebM — те же контейнеры, что и у видео
  if (container === 'video/mp4') return 'audio/mp4';
  if (container === 'video/webm') return 'audio/webm';
  return null;
}

/** Имя от собеседника — только как текст: без управляющих и невидимых символов (ZWJ оставляем — из него собираются эмодзи), обрезка по символам */
export function sanitizeReactionName(value: unknown): string {
  if (typeof value !== 'string') return 'Реакция';
  const clean = [...value.replace(/(?!‍)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()].slice(0, REACTION_NAME_MAX).join('').trim();
  return clean || 'Реакция';
}

/** Файл читается, в нём есть кадр, и стороны в пределах; нечитаемый считается непрошедшим */
export async function reactionFitsResolution(blob: Blob, mime: AvatarMime): Promise<boolean> {
  const isVideo = mime.startsWith('video/');
  const size = await probeDimensions(blob, isVideo);
  return size !== null && size[0] > 0 && size[1] > 0 && Math.max(size[0], size[1]) <= (isVideo ? REACTION_VIDEO_MAX_SIDE : REACTION_IMAGE_MAX_SIDE);
}

/** Не больше limit событий за windowMs; лишние отбрасываются */
export class RateWindow {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly at: number[] = [];

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(now = performance.now()): boolean {
    while (this.at.length && now - this.at[0] >= this.windowMs) this.at.shift();
    if (this.at.length >= this.limit) return false;
    this.at.push(now);
    return true;
  }
}

/** Маленькая статичная картинка (первый кадр) для чипов и списков, WebP с прозрачностью; null — не получилось */
export async function makeReactionThumb(media: AvatarMedia): Promise<string | null> {
  media.retain();
  try {
    const src = media.isVideo ? await media.capturePoster() : media.url;
    if (!src) return null;
    const img = new Image();
    img.src = src;
    await img.decode();
    const scale = Math.min(1, THUMB_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', 0.85);
  } catch {
    return null;
  } finally {
    media.release();
  }
}
