// Аватарки: данные (AvatarMedia) и отрисовка — картинка и GIF в <img>, видео в <video> без звука и без кнопок,
// при ошибке или без аватарки — кружок с первой буквой имени.
//
// Приложение оптимизируют для слабых ПК, поэтому живых <video> по одному на место (чип, своя, сцена, настройки),
// и каждое стоит на паузе, пока его не видно. Чат перерисовывается часто и сообщений в нём много: там только
// <img>, а вместо видео — один раз снятый постер (первый кадр).
import type { AvatarCrop, AvatarMime } from '../../shared/duo-api';

/** Предел файла; то же число — MAX_BYTES в src/main/avatar.ts */
export const AVATAR_MAX_BYTES = 16 * 1024 * 1024;
const AVATAR_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'] satisfies AvatarMime[];
export const isAvatarMime = (mime: unknown): mime is AvatarMime => typeof mime === 'string' && AVATAR_MIMES.includes(mime);

// Постер — весь кадр с исходными пропорциями: кадрирование применяется к нему в CSS, как и к живому видео, и
// при его смене постер не переснимается. В чате аватарка 24 px, запас на увеличение до 4× и масштаб экрана
const POSTER_SHORT_SIDE = 192;
const POSTER_LONG_SIDE = 768;
const POSTER_TIMEOUT_MS = 8000;
// Предел площади кадра: файл в 16 МБ разворачивается при декодировании в гигабайты. 4096×4096 — около 67 МБ RGBA
const MAX_PIXELS = 4096 * 4096;
const MAX_JPEG_PIXELS = 50_000_000; // JPEG не бывает анимированным, а снимки с телефона крупные
const PROBE_TIMEOUT_MS = 8000;

const hasAscii = (b: Uint8Array, at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/** MIME по сигнатуре или null. Та же проверка — sniffMime в src/main/avatar.ts */
export function sniffAvatarMime(b: Uint8Array): AvatarMime | null {
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

export const AVATAR_ZOOM_MAX = 4;
export const DEFAULT_AVATAR_CROP: Readonly<AvatarCrop> = Object.freeze({ x: 50, y: 50, zoom: 1 });

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Кадрирование в пределах; всё, что им не является (в том числе данные старой версии), — по умолчанию. Та же проверка — normalizeCrop в src/main/avatar.ts */
export function normalizeAvatarCrop(value: unknown): AvatarCrop {
  const { x, y, zoom } = (value ?? {}) as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(zoom)) return { ...DEFAULT_AVATAR_CROP };
  return { x: clamp(x, 0, 100), y: clamp(y, 0, 100), zoom: clamp(zoom, 1, AVATAR_ZOOM_MAX) };
}

export const sameAvatarCrop = (a: AvatarCrop, b: AvatarCrop) => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/**
 * Кадр на <img> или <video> внутри круга с overflow: hidden. Левый край картинки получается x·(box − W·zoom),
 * где W — ширина после cover: сдвиг линейный, и край картинки никогда не оказывается внутри круга.
 * Только стили: живое видео не перезапускается.
 */
export function applyAvatarCrop(el: HTMLElement, { x, y, zoom }: AvatarCrop): void {
  el.style.objectPosition = `${x}% ${y}%`;
  el.style.transformOrigin = `${x}% ${y}%`;
  el.style.transform = zoom > 1 ? `scale(${zoom})` : ''; // без увеличения — без лишнего слоя
}

/** Размер кадра без декодирования: <img> вне документа и видео с preload=metadata читают только заголовок */
export function probeDimensions(blob: Blob, isVideo: boolean): Promise<[number, number] | null> {
  return new Promise((resolve) => {
    const src = URL.createObjectURL(blob);
    const el = isVideo ? document.createElement('video') : new Image();
    const events: HTMLElement = el;
    let finished = false;
    const finish = (size: [number, number] | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      if (el instanceof HTMLVideoElement) el.load(); // отпускает декодер
      URL.revokeObjectURL(src);
      resolve(size);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    events.addEventListener('error', () => finish(null), { once: true });
    events.addEventListener(
      isVideo ? 'loadedmetadata' : 'load',
      () => finish(el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight]),
      { once: true },
    );
    if (el instanceof HTMLVideoElement) {
      el.muted = true;
      el.preload = 'metadata';
    }
    el.src = src;
  });
}

/** Файл читается, и кадр в пределах площади; нечитаемый считается непрошедшим */
export async function avatarFitsResolution(blob: Blob, mime: AvatarMime): Promise<boolean> {
  const size = await probeDimensions(blob, mime.startsWith('video/'));
  return size !== null && size[0] * size[1] <= (mime === 'image/jpeg' ? MAX_JPEG_PIXELS : MAX_PIXELS);
}

/** Первый кадр видео целиком, уменьшенный (JPEG, data:); null — не получилось */
function grabFirstFrame(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const src = URL.createObjectURL(blob);
    let finished = false;
    const finish = (result: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load(); // отпускает декодер
      URL.revokeObjectURL(src);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), POSTER_TIMEOUT_MS);
    video.muted = true;
    video.preload = 'auto';
    video.addEventListener('error', () => finish(null), { once: true });
    video.addEventListener(
      'loadeddata',
      () => {
        const { videoWidth, videoHeight } = video;
        if (!videoWidth || !videoHeight) return finish(null);
        const scale = Math.min(1, POSTER_SHORT_SIDE / Math.min(videoWidth, videoHeight), POSTER_LONG_SIDE / Math.max(videoWidth, videoHeight));
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(videoWidth * scale));
          canvas.height = Math.max(1, Math.round(videoHeight * scale));
          canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', 0.82));
        } catch {
          finish(null);
        }
      },
      { once: true },
    );
    video.src = src;
  });
}

/**
 * Проверенная аватарка. blob: URL живёт, пока кто-то удерживает её (retain/release): так старый адрес не
 * освобождается раньше, чем его перестали использовать элементы.
 */
export class AvatarMedia {
  readonly blob: Blob;
  readonly mime: AvatarMime;
  readonly hash: string;
  /** Меняется заменой объекта; файл и blob: URL при этом те же */
  crop: AvatarCrop;
  /** Первый кадр видео для чата; появляется после capturePoster */
  poster: string | null = null;
  private objectUrl: string | null = null;
  private refs = 0;
  private posterJob: Promise<string | null> | null = null;

  constructor(blob: Blob, mime: AvatarMime, hash: string, crop: AvatarCrop) {
    this.blob = blob;
    this.mime = mime;
    this.hash = hash;
    this.crop = crop;
  }

  get isVideo(): boolean {
    return this.mime.startsWith('video/');
  }

  /** Видео, постер которого ещё не снимали */
  get needsPoster(): boolean {
    return this.isVideo && !this.posterJob;
  }

  get inUse(): boolean {
    return this.refs > 0;
  }

  /** blob: URL; непустой, только пока аватарка удерживается */
  get url(): string {
    return this.objectUrl ?? '';
  }

  retain(): void {
    if (this.refs++ === 0) this.objectUrl = URL.createObjectURL(this.blob);
  }

  release(): void {
    if (--this.refs > 0 || !this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  /** Постер снимается один раз на аватарку */
  capturePoster(): Promise<string | null> {
    if (!this.isVideo) return Promise.resolve(null);
    this.posterJob ??= grabFirstFrame(this.blob).then((poster) => (this.poster = poster));
    return this.posterJob;
  }
}

const firstLetter = (name: string) => [...name.trim()][0]?.toLocaleUpperCase('ru') ?? '?';

// ---------------- живые видео: играют, только пока их видно ----------------

let windowShown = true;
const liveViews = new Set<AvatarView>();
const pageVisible = () => windowShown && !document.hidden;
const pageWatchers = new Set<(visible: boolean) => void>();
const syncLiveViews = () => {
  liveViews.forEach((view) => view.syncPlayback());
  pageWatchers.forEach((watcher) => watcher(pageVisible()));
};
/** Сразу сообщает, видно ли окно, и дальше — при каждой смене; возвращает отписку */
export function watchPageVisible(watcher: (visible: boolean) => void): () => void {
  pageWatchers.add(watcher);
  watcher(pageVisible());
  return () => pageWatchers.delete(watcher);
}
document.addEventListener('visibilitychange', syncLiveViews);
// document.hidden при backgroundThrottling: false не меняется — о свёрнутом окне, трее и потере фокуса сообщает главный процесс
window.duo.onWindowVisibility((shown) => {
  windowShown = shown;
  syncLiveViews();
});

const observed = new WeakMap<Element, AvatarView>();
/** Скрытая панель (полноэкранный режим), спрятанная сцена, закрытый диалог — «не пересекается» с окном */
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) observed.get(entry.target)?.setOnScreen(entry.isIntersecting);
});

/** Аватарка в постоянном месте интерфейса */
export class AvatarView {
  private readonly el: HTMLElement;
  private readonly letter = document.createElement('span');
  private readonly clip = document.createElement('span');
  private media: AvatarMedia | null = null;
  private element: HTMLImageElement | HTMLVideoElement | null = null;
  private video: HTMLVideoElement | null = null;
  /** Кадрирование, уже применённое к element */
  private shownCrop: AvatarCrop | null = null;
  private onScreen = false;
  private speaking = false;

  constructor(el: HTMLElement) {
    this.el = el;
    this.letter.className = 'avatar-letter';
    this.letter.textContent = '?';
    this.clip.className = 'avatar-clip';
    el.append(this.letter, this.clip);
    observed.set(el, this);
  }

  /** Можно вызывать при каждой перерисовке: та же аватарка не перезапускается, новое кадрирование только меняет стили */
  set(media: AvatarMedia | null, name: string): void {
    const letter = firstLetter(name);
    if (this.letter.textContent !== letter) this.letter.textContent = letter;
    if (media === this.media) {
      this.applyCrop();
      return;
    }
    this.dropElement();
    this.media?.release();
    this.media = media;
    if (!media) return;
    media.retain();
    if (media.isVideo) this.mountVideo(media);
    else this.mountImage(media);
    this.applyCrop();
  }

  private applyCrop(): void {
    const crop = this.media?.crop;
    if (!this.element || !crop || crop === this.shownCrop) return;
    this.shownCrop = crop;
    applyAvatarCrop(this.element, crop);
  }

  private mountImage(media: AvatarMedia): void {
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.addEventListener('load', () => this.element === img && this.el.classList.add('has-media'));
    img.addEventListener('error', () => this.element === img && this.dropElement());
    img.src = media.url;
    this.element = img;
    this.clip.append(img);
  }

  private mountVideo(media: AvatarMedia): void {
    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.controls = false;
    video.disablePictureInPicture = true;
    video.tabIndex = -1;
    video.addEventListener('loadeddata', () => {
      // Только звуковая дорожка — показывать нечего
      if (this.video === video && !video.videoWidth) this.dropElement();
      else if (this.video === video) this.el.classList.add('has-media');
    });
    video.addEventListener('error', () => this.video === video && this.dropElement());
    video.src = media.url;
    this.element = this.video = video;
    this.clip.append(video);
    liveViews.add(this);
    observer.observe(this.el); // первое срабатывание скажет, видно ли элемент: до него — пауза
    this.syncPlayback();
  }

  /** Убирает элемент и отпускает декодер; остаётся буква */
  private dropElement(): void {
    const video = this.video;
    if (video) {
      this.video = null;
      this.onScreen = false;
      liveViews.delete(this);
      observer.unobserve(this.el);
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    this.element?.remove();
    this.element = null;
    this.shownCrop = null;
    this.el.classList.remove('has-media');
  }

  setOnScreen(visible: boolean): void {
    if (this.onScreen === visible) return;
    this.onScreen = visible;
    this.syncPlayback();
  }

  syncPlayback(): void {
    const video = this.video;
    if (!video) return;
    if (!this.onScreen || !pageVisible()) {
      video.pause(); // и отменяет autoplay, пока элемент не показан
    } else if (video.paused) {
      video.play().catch((err: Error) => {
        // AbortError — запуск прервала пауза, это штатно
        if (err.name !== 'AbortError' && this.video === video) this.dropElement();
      });
    }
  }

  setSpeaking(on: boolean): void {
    if (on === this.speaking) return;
    this.speaking = on;
    this.el.classList.toggle('speaking', on);
  }
}

/** Что показать в чате: картинка или GIF как есть, у видео — постер */
export function avatarThumbSrc(media: AvatarMedia | null): string | null {
  return (media?.isVideo ? media.poster : media?.url) || null;
}

/** Маленькая аватарка без видео (чат): заменяет всё содержимое элемента */
export function renderAvatarThumb(el: HTMLElement, src: string | null, name: string, crop: AvatarCrop = DEFAULT_AVATAR_CROP): void {
  const letter = document.createElement('span');
  letter.className = 'avatar-letter';
  letter.textContent = firstLetter(name);
  el.classList.remove('has-media');
  el.replaceChildren(letter);
  if (!src) return;
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  img.addEventListener('load', () => el.classList.add('has-media'), { once: true });
  img.addEventListener('error', () => img.remove(), { once: true });
  img.src = src;
  applyAvatarCrop(img, crop);
  const clip = document.createElement('span');
  clip.className = 'avatar-clip';
  clip.append(img);
  el.append(clip);
}

/** Новое кадрирование у уже нарисованной маленькой аватарки: картинка не пересоздаётся */
export function updateAvatarThumbCrop(el: HTMLElement, crop: AvatarCrop): void {
  const img = el.querySelector('img');
  if (img) applyAvatarCrop(img, crop);
}

/** «Говорит»: включается сразу, выключается через holdMs после спада — чтобы кольцо не дёргалось */
export class SpeakingGate {
  private readonly apply: (on: boolean) => void;
  private readonly holdMs: number;
  private on = false;
  private until = 0;

  constructor(apply: (on: boolean) => void, holdMs = 250) {
    this.apply = apply;
    this.holdMs = holdMs;
  }

  update(active: boolean, now: number): void {
    if (active) this.until = now + this.holdMs;
    const next = active || now < this.until;
    if (next === this.on) return;
    this.on = next;
    this.apply(next);
  }
}
