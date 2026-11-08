// Редактор кадра аватарки: отдельный модальный диалог поверх настроек. Сам файл не меняется — на выходе только
// { x, y, zoom } (см. applyAvatarCrop в js/avatar.ts).
//
// В круге картинка лежит так же, как и везде: шириной W после cover, левый край — x·(box − W·zoom). Только здесь
// она не обрезается по рамке элемента (нужно видеть и то, что уйдёт за круг), поэтому положение задаётся прямо
// через transform, а маленький предпросмотр рисуется настоящим applyAvatarCrop.
import { $ } from './ui.ts';
import { AVATAR_ZOOM_MAX, DEFAULT_AVATAR_CROP, applyAvatarCrop, normalizeAvatarCrop, watchPageVisible } from './avatar.ts';
import type { AvatarCrop, AvatarMime } from '../../shared/duo-api';

const STAGE = 320; // сторона области; = .avatar-editor-stage в styles.css
const BOX = 240; // диаметр круга; = .avatar-editor-mask (inset 40px)
const INSET = (STAGE - BOX) / 2;
const MIN_ROOM = 0.5; // запас по оси меньше этого (px) — ось не двигается
const WHEEL_SPEED = 0.002;
const WHEEL_LINE_PX = 40; // колесо, считающее строками
const KEY_STEP = 2;
const KEY_STEP_FAST = 12; // с Shift

const KEY_MOVES: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

type MediaElement = HTMLImageElement | HTMLVideoElement;

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  cropX: number;
  cropY: number;
}

/** Позиция оси, при которой картинка размером size сдвинута на deltaPx от положения position */
function shifted(position: number, deltaPx: number, size: number): number {
  const room = size - BOX;
  return room < MIN_ROOM ? position : position - (deltaPx / room) * 100;
}

/** Позиция оси после смены масштаба: точка картинки под центром круга остаётся под ним */
function keepCenter(position: number, size: number, zoom: number, nextZoom: number): number {
  const edge = (position / 100) * (BOX - size * zoom);
  const point = (BOX / 2 - edge) / (size * zoom);
  const room = BOX - size * nextZoom;
  return Math.abs(room) < 0.001 ? position : ((BOX / 2 - point * size * nextZoom) / room) * 100;
}

const makeElement = (isVideo: boolean): MediaElement => {
  if (!isVideo) return Object.assign(new Image(), { alt: '', draggable: false });
  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.controls = false;
  video.disablePictureInPicture = true;
  video.tabIndex = -1;
  return video;
};

function releaseElement(el: MediaElement | null): void {
  if (!el) return;
  if (el instanceof HTMLVideoElement) {
    el.pause();
    el.removeAttribute('src');
    el.load(); // отпускает декодер
  }
  el.remove();
}

export class AvatarEditor {
  private readonly dialog = $<HTMLDialogElement>('#avatarEditor');
  private readonly stage = $('#avatarEditorStage');
  private readonly preview = $('#avatarEditorPreview');
  private readonly slider = $<HTMLInputElement>('#avatarEditorZoom');
  private readonly done = $<HTMLButtonElement>('#btnAvatarEditorDone');
  private readonly errorEl = $('#avatarEditorError');
  private crop: AvatarCrop = { ...DEFAULT_AVATAR_CROP };
  /** Размер картинки в круге при zoom 1; null — ещё не загрузилась */
  private size: { w: number; h: number } | null = null;
  private media: MediaElement | null = null;
  private previewMedia: MediaElement | null = null;
  private previewClip: HTMLElement | null = null;
  private url = '';
  private drag: Drag | null = null;
  private unwatch: (() => void) | null = null;
  private resolve: ((crop: AvatarCrop | null) => void) | null = null;
  private result: AvatarCrop | null = null;

  constructor() {
    this.stage.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.stage.addEventListener('pointermove', (event) => this.onPointerMove(event));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) this.stage.addEventListener(type, () => this.endDrag());
    this.stage.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.slider.addEventListener('input', () => this.zoomTo(Number(this.slider.value)));
    this.dialog.addEventListener('keydown', (event) => this.onKeyDown(event));
    $('#btnAvatarEditorReset').addEventListener('click', () => this.setCrop(DEFAULT_AVATAR_CROP));
    $('#btnAvatarEditorCancel').addEventListener('click', () => this.dialog.close());
    this.done.addEventListener('click', () => {
      // Лишние знаки после запятой ни на диске, ни в канале не нужны
      const { x, y, zoom } = this.crop;
      this.result = { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), zoom: Number(zoom.toFixed(3)) };
      this.dialog.close();
    });
    // Сюда приходят все способы закрыть окно, и Esc тоже
    this.dialog.addEventListener('close', () => this.finish());
  }

  /** Показывает редактор; кадрирование при «Готово», null — отмена */
  open(blob: Blob, mime: AvatarMime, crop: AvatarCrop): Promise<AvatarCrop | null> {
    if (this.resolve) return Promise.resolve(null);
    const isVideo = mime.startsWith('video/');
    this.crop = normalizeAvatarCrop(crop);
    this.result = null;
    this.size = null;
    this.url = URL.createObjectURL(blob);
    this.done.disabled = true;
    this.showError('');
    this.mountStage(isVideo);
    this.mountPreview(isVideo);
    this.syncControls();
    this.dialog.showModal();
    this.stage.focus();
    return new Promise((resolve) => (this.resolve = resolve));
  }

  private showError(text: string): void {
    this.errorEl.textContent = text;
    this.errorEl.hidden = !text;
  }

  private mountStage(isVideo: boolean): void {
    const el = makeElement(isVideo);
    const events: HTMLElement = el;
    el.hidden = true;
    this.media = el;
    const failed = () => {
      if (this.media !== el) return;
      el.hidden = true;
      this.size = null;
      this.done.disabled = true;
      this.showError('Этот файл не получается показать: возможно, он повреждён или в нём неподдерживаемый кодек.');
    };
    const ready = (width: number, height: number) => {
      if (this.media !== el) return;
      if (!width || !height) return failed(); // только звуковая дорожка — показывать нечего
      const cover = Math.max(BOX / width, BOX / height);
      this.size = { w: width * cover, h: height * cover };
      el.style.width = `${this.size.w}px`;
      el.style.height = `${this.size.h}px`;
      el.hidden = false;
      this.done.disabled = false;
      this.render();
      this.rebaseDrag(); // запас у осей мог стать другим
    };
    events.addEventListener('error', failed);
    if (el instanceof HTMLVideoElement) {
      el.loop = true;
      el.preload = 'auto';
      el.addEventListener('loadedmetadata', () => ready(el.videoWidth, el.videoHeight));
      // Разрешение может смениться посреди файла (например, запись окна); 0 — кадра ещё нет, это не ошибка
      el.addEventListener('resize', () => {
        if (el.videoWidth && el.videoHeight) ready(el.videoWidth, el.videoHeight);
      });
    } else {
      el.addEventListener('load', () => ready(el.naturalWidth, el.naturalHeight));
    }
    el.src = this.url;
    this.stage.prepend(el);
    if (el instanceof HTMLVideoElement) {
      // Пока окно свёрнуто или в трее, декодер простаивает
      this.unwatch = watchPageVisible((visible) => {
        if (!visible) el.pause();
        else void el.play().catch(() => {}); // сбой декодирования приходит событием error
      });
    }
  }

  /** У видео предпросмотр стоит на первом кадре: так оно выглядит в чате, и второй декодер не работает постоянно */
  private mountPreview(isVideo: boolean): void {
    const el = makeElement(isVideo);
    if (el instanceof HTMLVideoElement) el.preload = 'auto';
    el.src = this.url;
    const clip = document.createElement('span');
    clip.className = 'avatar-clip';
    clip.append(el);
    this.preview.replaceChildren(clip);
    this.previewMedia = el;
    this.previewClip = clip;
  }

  private setCrop(crop: AvatarCrop): void {
    this.crop = normalizeAvatarCrop(crop);
    this.render();
    this.syncControls();
  }

  private syncControls(): void {
    this.slider.value = String(this.crop.zoom);
    if (this.previewMedia) applyAvatarCrop(this.previewMedia, this.crop);
  }

  private render(): void {
    if (!this.size || !this.media) return;
    const { x, y, zoom } = this.crop;
    const left = INSET + (x / 100) * (BOX - this.size.w * zoom);
    const top = INSET + (y / 100) * (BOX - this.size.h * zoom);
    this.media.style.transform = `translate(${left}px, ${top}px) scale(${zoom})`;
  }

  private zoomTo(target: number): void {
    if (!this.size) return;
    const { x, y, zoom } = this.crop;
    const next = Math.min(AVATAR_ZOOM_MAX, Math.max(1, target));
    this.setCrop({ x: keepCenter(x, this.size.w, zoom, next), y: keepCenter(y, this.size.h, zoom, next), zoom: next });
    this.rebaseDrag();
  }

  /** Запас у осей стал другим: дальше тянем от текущего положения, иначе картинка прыгнет */
  private rebaseDrag(): void {
    const drag = this.drag;
    if (drag) Object.assign(drag, { startX: drag.lastX, startY: drag.lastY, cropX: this.crop.x, cropY: this.crop.y });
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * WHEEL_LINE_PX : event.deltaY;
    this.zoomTo(this.crop.zoom * Math.exp(-delta * WHEEL_SPEED));
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.size) return;
    this.stage.setPointerCapture(event.pointerId);
    this.stage.classList.add('dragging');
    this.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, cropX: this.crop.x, cropY: this.crop.y };
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || !this.size || event.pointerId !== drag.pointerId) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    const { w, h } = this.size;
    const { zoom } = this.crop;
    this.setCrop({ x: shifted(drag.cropX, event.clientX - drag.startX, w * zoom), y: shifted(drag.cropY, event.clientY - drag.startY, h * zoom), zoom });
  }

  private endDrag(): void {
    this.drag = null;
    this.stage.classList.remove('dragging');
  }

  private onKeyDown(event: KeyboardEvent): void {
    const move = KEY_MOVES[event.key];
    // На ползунке стрелки меняют масштаб, как и положено ползунку
    if (!move || !this.size || event.target === this.slider || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    const step = event.shiftKey ? KEY_STEP_FAST : KEY_STEP;
    const { x, y, zoom } = this.crop;
    this.setCrop({ x: shifted(x, move[0] * step, this.size.w * zoom), y: shifted(y, move[1] * step, this.size.h * zoom), zoom });
  }

  private finish(): void {
    this.endDrag();
    this.unwatch?.();
    this.unwatch = null;
    releaseElement(this.media);
    releaseElement(this.previewMedia);
    this.previewClip?.remove();
    this.media = this.previewMedia = this.previewClip = null;
    this.size = null;
    URL.revokeObjectURL(this.url);
    this.url = '';
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(this.result);
  }
}
