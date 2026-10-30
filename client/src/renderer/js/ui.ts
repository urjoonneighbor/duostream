// Мелкие помощники интерфейса: поиск элементов, уведомления, иконки.

/** Элемент по селектору. Элементы интерфейса есть в index.html всегда — null здесь означает ошибку разметки. */
export const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T => root.querySelector(selector) as T;

export type ToastType = 'info' | 'ok' | 'warn' | 'error';
export interface ToastAction {
  label: string;
  onClick: () => void;
}

const ICONS: Record<string, string> = {
  mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micOff: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  leave: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  wave: '<path d="M2 12h3l2-6 3 12 3-9 2 5 2-2h5"/>',
  headphones:
    '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  headphonesOff:
    '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M3 3l18 18"/>',
  sliders:
    '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  clip: '<path d="M20 12l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
};

export function iconSvg(name: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

/** Заполняет все элементы с data-icon */
export function renderIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) el.innerHTML = iconSvg(el.dataset.icon ?? '');
}

export function setIcon(el: HTMLElement, name: string): void {
  el.dataset.icon = name;
  el.innerHTML = iconSvg(name);
}

/**
 * @param ms 0 — висит, пока не нажмут кнопку или ✕
 * @param action кнопка в уведомлении
 */
export function toast(message: string, type: ToastType = 'info', ms = 4500, action: ToastAction | null = null): void {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  if (action || !ms) {
    const buttons = document.createElement('div');
    buttons.className = 'toast-actions';
    if (action) {
      const button = document.createElement('button');
      button.textContent = action.label;
      button.addEventListener('click', () => {
        el.remove();
        action.onClick();
      });
      buttons.append(button);
    }
    const close = document.createElement('button');
    close.className = 'ghost';
    close.textContent = '✕';
    close.title = 'Закрыть';
    close.addEventListener('click', () => el.remove());
    buttons.append(close);
    el.append(buttons);
  }
  $('#toasts').append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  (type === 'error' ? console.error : console.log)(`[toast] ${message}`);
}

/** Пары [подпись, значение] → содержимое <dl> */
export function renderList(dl: HTMLElement, rows: [string, string][]): void {
  dl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}
