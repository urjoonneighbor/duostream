// Показ реакций: значки в чипах, выбор реакции и слой всплывающих реакций поверх видео.
//
// Приложение оптимизируют для слабых ПК: в чипах только <img> (у видео — постер), живых <video> на весь интерфейс
// не больше MAX_LIVE_VIDEOS, анимация — только transform и opacity.
import { BUILTIN_REACTIONS, isBuiltinReaction } from './reactions.ts';
import type { AvatarMedia } from './avatar.ts';
import type { ReactionSync } from './reaction-sync.ts';

const MAX_LIVE_VIDEOS = 4;
const MAX_FLOATS = 12;
const FLOAT_MIN_MS = 3000;
const FLOAT_MAX_MS = 4000;
const FLOAT_WIDTH = 104; // .rx-float-media
const FLOAT_TEXT_WIDTH = 190; // .rx-float .rx-pending
const FLOAT_EDGE = 12;
const CHAT_RESERVED_PX = 384; // панель чата с отступами, как у .stage.chat-open .hud

/** Своя лёгкая анимация у каждого эмодзи — классы .rx-anim-* в styles.css */
const EMOJI_ANIMATION: Record<string, string> = {
  '👍': 'bounce',
  '❤️': 'pulse',
  '😂': 'wobble',
  '😮': 'pulse',
  '😢': 'bounce',
  '🔥': 'flicker',
  '🎉': 'spin',
  '👏': 'clap',
  '💀': 'wobble',
  '🤡': 'spin',
};

/** Класс анимации встроенной реакции */
export const reactionAnimClass = (key: string) => `rx-anim-${EMOJI_ANIMATION[key] ?? 'pulse'}`;

let liveVideos = 0;
/** Живое превью под курсором: курсор один, а mouseleave не приходит, если узел убрали из документа */
let releaseHover: (() => void) | null = null;

/** Список перерисовывается или закрывается: превью отпускает декодер */
export function stopHoverPreview(): void {
  releaseHover?.();
  releaseHover = null;
}

/** Живой <video> без звука; null — живых уже слишком много, показываем постер. Возвращает элемент и его освобождение */
function mountLiveVideo(media: AvatarMedia): { el: HTMLVideoElement; free: () => void } | null {
  if (liveVideos >= MAX_LIVE_VIDEOS) return null;
  liveVideos++;
  media.retain();
  const video = document.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.controls = false;
  video.disablePictureInPicture = true;
  video.tabIndex = -1;
  video.src = media.url;
  video.play().catch(() => {});
  let freed = false;
  return {
    el: video,
    free: () => {
      if (freed) return;
      freed = true;
      liveVideos--;
      video.pause();
      video.removeAttribute('src');
      video.load(); // отпускает декодер
      media.release();
    },
  };
}

function image(src: string, className: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = className;
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  img.src = src;
  return img;
}

function pendingName(name: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'rx-pending';
  el.textContent = name; // только как текст
  el.title = name;
  return el;
}

/** Значок реакции в чипе или кнопке: эмодзи или маленькая картинка, у файла, который ещё не дошёл, — имя */
export function reactionGlyph(key: string, sync: ReactionSync): HTMLElement {
  if (isBuiltinReaction(key)) {
    const emoji = document.createElement('span');
    emoji.className = 'rx-emoji';
    emoji.textContent = key;
    return emoji;
  }
  const src = sync.thumbSrc(key);
  return src ? image(src, 'rx-thumb') : pendingName(sync.label(key));
}

/** Пока курсор над кнопкой — живое превью: GIF в <img>, видео беззвучно; при уходе декодер отпускается */
export function bindHoverPreview(host: HTMLElement, key: string, sync: ReactionSync): void {
  let token = 0;
  host.addEventListener('mouseenter', () => {
    stopHoverPreview();
    const mine = ++token;
    void sync.ensureMedia(key).then((media) => {
      if (mine !== token || !media || !host.isConnected) return;
      let live: HTMLElement;
      let free: () => void;
      if (media.isVideo) {
        const video = mountLiveVideo(media);
        if (!video) return;
        live = video.el;
        free = video.free;
      } else {
        media.retain();
        live = image(media.url, '');
        free = () => media.release();
      }
      live.classList.add('rx-hover-live');
      host.append(live);
      stopHoverPreview();
      releaseHover = () => {
        live.remove();
        free();
      };
    });
  });
  host.addEventListener('mouseleave', () => {
    token++;
    stopHoverPreview();
  });
}

/** Выбор реакции: встроенные, свои и «Создать свою» */
export class ReactionPicker {
  private readonly root: HTMLElement;
  private readonly sync: ReactionSync;
  private readonly onPick: (key: string) => void;
  private readonly onCreate: () => void;

  constructor(root: HTMLElement, sync: ReactionSync, { onPick, onCreate }: { onPick: (key: string) => void; onCreate: () => void }) {
    this.root = root;
    this.sync = sync;
    this.onPick = onPick;
    this.onCreate = onCreate;
    root.addEventListener('click', (e) => {
      const target = e.target as Element;
      const button = target.closest<HTMLButtonElement>('button[data-key]');
      if (button?.dataset.key) this.onPick(button.dataset.key);
      else if (target.closest('.rx-create-link')) this.onCreate();
    });
    sync.on('change', ({ key }) => key === null && !root.hidden && this.render());
  }

  render(): void {
    stopHoverPreview();
    const grid = (keys: readonly string[], custom: boolean) => {
      const el = document.createElement('div');
      el.className = `rx-grid${custom ? ' rx-grid-custom' : ''}`;
      for (const key of keys) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'rx-pick';
        button.dataset.key = key;
        button.title = this.sync.label(key);
        button.append(reactionGlyph(key, this.sync));
        if (custom) bindHoverPreview(button, key, this.sync);
        else button.classList.add(reactionAnimClass(key));
        el.append(button);
      }
      return el;
    };
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'rx-create-link ghost';
    create.textContent = 'Создать свою…';
    const own = this.sync.ownList.map((r) => r.id);
    this.root.replaceChildren(...[grid(BUILTIN_REACTIONS, false), ...(own.length ? [grid(own, true)] : []), create]);
  }
}

/** Всплывающие реакции поверх видео: только transform и opacity; живут 3–4 с, не больше MAX_FLOATS сразу */
export class ReactionLayer {
  private readonly root: HTMLElement;
  private readonly sync: ReactionSync;
  private readonly floats: { el: HTMLElement; remove: () => void }[] = [];

  constructor(root: HTMLElement, sync: ReactionSync) {
    this.root = root;
    this.sync = sync;
  }

  spawn(key: string): void {
    if (this.floats.length >= MAX_FLOATS) this.floats[0].remove();
    const el = document.createElement('div');
    el.className = 'rx-float';
    const duration = FLOAT_MIN_MS + Math.random() * (FLOAT_MAX_MS - FLOAT_MIN_MS);
    el.style.animationDuration = `${duration}ms`;
    let cleanup: (() => void) | null = null;
    if (isBuiltinReaction(key)) {
      const emoji = document.createElement('span');
      emoji.className = `rx-float-emoji rx-emoji ${reactionAnimClass(key)}`;
      emoji.textContent = key;
      el.append(emoji);
    } else {
      const media = this.sync.media(key);
      if (media?.isVideo) {
        const video = mountLiveVideo(media);
        if (video) {
          video.el.className = 'rx-float-media';
          el.append(video.el);
          cleanup = video.free;
        }
      } else if (media) {
        media.retain();
        el.append(image(media.url, 'rx-float-media'));
        cleanup = () => media.release();
      }
      if (!el.childElementCount) {
        const src = this.sync.thumbSrc(key);
        el.append(src ? image(src, 'rx-float-media') : pendingName(this.sync.label(key)));
      }
    }
    // Панель чата лежит выше слоя: то, что всплывает под ней, не видно. Запас по ширине — чтобы не обрезало и край
    const usable = this.root.clientWidth - (this.root.closest('.stage')?.classList.contains('chat-open') ? CHAT_RESERVED_PX : 0);
    const itemWidth = el.querySelector('.rx-pending') ? FLOAT_TEXT_WIDTH : FLOAT_WIDTH;
    el.style.left = `${FLOAT_EDGE + Math.random() * Math.max(0, usable - itemWidth - 2 * FLOAT_EDGE)}px`;
    const entry = {
      el,
      remove: () => {
        const index = this.floats.indexOf(entry);
        if (index < 0) return;
        this.floats.splice(index, 1);
        clearTimeout(timer);
        el.remove();
        cleanup?.();
      },
    };
    const timer = setTimeout(entry.remove, duration + 100); // animationend не придёт, пока окно скрыто
    this.floats.push(entry);
    el.addEventListener('animationend', (e) => e.target === el && entry.remove());
    this.root.append(el);
  }
}
