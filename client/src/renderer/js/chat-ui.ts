// Панель чата: сообщения, файлы с прогрессом, отправка (кнопка, Enter, перетаскивание файлов в окно).
import { $, iconSvg, toast } from './ui.ts';
import { URL_PATTERN, SPOILER_PATTERN, hideSpoilers, type Chat, type ChatItem, type MessageItem, type Transfer, type TransferStatus } from './chat.ts';
import { avatarThumbSrc, renderAvatarThumb, updateAvatarThumbCrop, type AvatarMedia } from './avatar.ts';
import type { AvatarWho } from './avatar-sync.ts';
import { ReactionPicker, bindHoverPreview, reactionAnimClass, reactionGlyph, stopHoverPreview } from './reaction-ui.ts';
import { isBuiltinReaction } from './reactions.ts';
import type { ReactionSync } from './reaction-sync.ts';
import type { AvatarCrop } from '../../shared/duo-api';

const STATUS: Record<TransferStatus, (t: Transfer) => string> = {
  offered: (t) => (t.mine ? 'ждёт, пока собеседник примет' : 'собеседник предлагает файл'),
  sending: () => 'отправка',
  finishing: () => 'отправлено, ждём подтверждения',
  receiving: () => 'приём',
  done: (t) => (t.mine ? 'доставлен' : 'сохранён'),
  rejected: (t) => (t.mine ? 'собеседник отказался' : 'отклонён'),
  cancelled: (t) => `не передан: ${t.error ?? 'отменено'}`,
  error: (t) => `ошибка: ${t.error ?? ''}`,
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

const time = (ts: number) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Длиннее — сообщение отправляется файлом .txt */
const LONG_TEXT_CHARS = 2000;

/** Уведомление о реакции при закрытом чате — не чаще */
const REACTION_TOAST_MS = 2500;

/** Метка времени для имени файла: 2026-10-27 22-45-10 */
const fileStamp = () => new Date().toLocaleString('sv-SE').replace(/:/g, '-');

/** Картинку — в буфер обмена (PNG: другие форматы буфер обмена Windows через браузер не принимает) */
async function copyImage(img: HTMLImageElement): Promise<void> {
  try {
    await img.decode().catch(() => {});
    const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Картинка скопирована', 'ok', 2000);
  } catch (err) {
    toast(`Не удалось скопировать картинку: ${(err as Error).message}`, 'error');
  }
}

export class ChatPanel {
  private readonly chat: Chat;
  private readonly peerName: () => string;
  private readonly canSend: () => boolean;
  private unread = 0;
  /** Открытые спойлеры: «id сообщения:номер» и «f<id передачи>» — переживают перерисовку */
  private readonly revealed = new Set<string>();
  /** Следующее отправленное — под спойлер (кнопка в поле ввода) */
  private spoilerNext = false;
  /** Картинка под курсором — её копирует Ctrl+C */
  private hoverImage: HTMLImageElement | null = null;
  private readonly nodes = new Map<number, HTMLElement>(); // id → элемент списка
  private readonly panel = $('#chatPanel');
  private readonly avatar: (who: AvatarWho) => { media: AvatarMedia | null; name: string };
  /** Что сейчас нарисовано в аватарках у сообщений: без изменений список не обходим */
  private readonly avatarKeys: Record<AvatarWho, string> = { me: '', peer: '' };
  private readonly avatarCrops: Record<AvatarWho, AvatarCrop | undefined> = { me: undefined, peer: undefined };
  /** Имена ушедших собеседников у их сообщений: история не должна приписываться следующему */
  private readonly sealedAuthors = new Map<number, string>();
  private readonly reactions: ReactionSync;
  private readonly picker: ReactionPicker;
  private readonly pickerRoot = $('#chatReactionPicker');
  /** Сообщение, для которого открыт выбор реакции */
  private pickerFor: number | null = null;
  /** Выбор открыт с клавиатуры: фокус вернётся на кнопку сообщения */
  private pickerByKeyboard = false;
  /** Новые чипы «id:ключ»: анимируются один раз, при следующей отрисовке */
  private readonly freshReactions = new Set<string>();
  private lastReactionToast = -Infinity;

  constructor(
    chat: Chat,
    {
      peerName,
      canSend,
      avatar,
      openReactionSettings,
    }: {
      peerName: () => string;
      canSend: () => boolean;
      avatar: (who: AvatarWho) => { media: AvatarMedia | null; name: string };
      openReactionSettings: () => void;
    },
  ) {
    this.chat = chat;
    this.peerName = peerName;
    this.canSend = canSend;
    this.avatar = avatar;
    this.reactions = chat.reactions;
    this.picker = new ReactionPicker(this.pickerRoot, this.reactions, {
      onPick: (key) => this.pickReaction(key),
      onCreate: () => {
        this.closePicker();
        openReactionSettings();
      },
    });

    chat.on('change', ({ item }) => this.onChange(item));
    chat.on('reaction', ({ item, key, who, on, silent }) => this.onReaction(item, key, who, on, silent));
    this.reactions.on('change', ({ key }) => key !== null && this.refreshReaction(key));
    document.addEventListener('pointerdown', (e) => {
      const target = e.target as Element;
      if (!this.pickerRoot.hidden && !target.closest('#chatReactionPicker') && !target.closest('.reaction-add')) this.closePicker();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePicker(true);
    });
    $('#chatList').addEventListener('scroll', () => this.closePicker(), { passive: true });
    $('#btnChat').addEventListener('click', () => this.toggle());
    $('#chatClose').addEventListener('click', () => this.toggle(false));
    $('#chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendInput();
    });
    $('#chatInput').addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendInput();
      }
    });
    $('#chatAttach').addEventListener('click', () => $('#chatFile').click());
    $('#chatFile').addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      this.sendFiles(input.files);
      input.value = '';
    });
    $('#chatSpoiler').addEventListener('click', () => {
      this.setSpoilerNext(!this.spoilerNext);
      $('#chatInput').focus();
    });
    $('#chatList').addEventListener('click', (e) => {
      const target = e.target as Element;
      // Закрытый спойлер: первый щелчок только открывает (ссылку и картинку под ним — следующим)
      const spoiler = target.closest<HTMLElement>('.spoiler:not(.revealed)');
      if (spoiler) {
        e.preventDefault();
        this.revealed.add(spoiler.dataset.spoiler ?? '');
        spoiler.classList.add('revealed');
        return;
      }
      const link = target.closest<HTMLAnchorElement>('a.chat-link, a.link-card');
      if (link) {
        e.preventDefault(); // внутри окна переходы запрещены — открываем в браузере
        void window.duo.openLink(link.href);
        return;
      }
      const thumb = target.closest<HTMLImageElement>('img.chat-thumb');
      if (thumb) this.viewImage(thumb.src, thumb.alt);
      else this.onAction(target.closest<HTMLButtonElement>('button[data-act]'), e.detail === 0);
    });
    $('#imageView').addEventListener('click', () => $<HTMLDialogElement>('#imageView').close());
    $('#chatList').addEventListener('mousemove', (e) => {
      const img = (e.target as Element).closest<HTMLImageElement>('img.chat-thumb');
      this.hoverImage = img && !img.closest('.spoiler:not(.revealed)') ? img : null;
    });
    $('#chatList').addEventListener('mouseleave', () => (this.hoverImage = null));
    this.bindCopyImage();
    this.bindDrop();
    this.bindPaste();
  }

  get open(): boolean {
    return !this.panel.hidden;
  }

  toggle(show = !this.open): void {
    this.panel.hidden = !show;
    $('#stage').classList.toggle('chat-open', show);
    if (show) {
      this.unread = 0;
      this.renderBadge();
      $('#chatInput').focus();
      this.scrollDown();
    }
  }

  /** Длинный текст (лог, код) уходит файлом .txt — в ленте он нечитаем, а сообщение ограничено 20 000 символов */
  private sendInput(): void {
    const input = $<HTMLTextAreaElement>('#chatInput');
    let text = input.value.trim();
    if (!text) return;
    if (this.spoilerNext && text.length <= LONG_TEXT_CHARS) text = `||${text}||`;
    if (text.length > LONG_TEXT_CHARS) {
      if (!this.canSend()) {
        toast('Длинный текст уйдёт файлом — его можно отправить, когда собеседник подключён', 'warn');
        return;
      }
      this.sendFiles([new File([text], `Сообщение ${fileStamp()}.txt`, { type: 'text/plain' })]);
    } else {
      this.chat.sendText(text);
      this.setSpoilerNext(false);
    }
    input.value = '';
  }

  private setSpoilerNext(on: boolean): void {
    this.spoilerNext = on;
    const button = $('#chatSpoiler');
    button.setAttribute('aria-pressed', String(on));
    button.classList.toggle('active', on);
  }

  /**
   * Ctrl+C без выделенного текста копирует картинку: открытую во весь размер или ту, что под курсором в чате.
   * Выделенный текст копируется как обычно
   */
  private bindCopyImage(): void {
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.code !== 'KeyC') return;
      if (window.getSelection()?.toString()) return;
      const viewer = $<HTMLDialogElement>('#imageView');
      const img = viewer.open ? $<HTMLImageElement>('#imageViewImg') : this.hoverImage;
      if (!img?.isConnected) return;
      e.preventDefault();
      void copyImage(img);
    });
  }

  private sendFiles(files: Iterable<File> | null | undefined): void {
    const list = [...(files ?? [])];
    if (!list.length) return;
    if (!this.canSend()) {
      toast('Файлы можно отправить, когда собеседник подключён', 'warn');
      return;
    }
    this.chat.sendFiles(list, { spoiler: this.spoilerNext });
    this.setSpoilerNext(false);
    this.toggle(true);
  }

  /** Файлы, перетащенные в окно, — сразу собеседнику */
  private bindDrop(): void {
    const stage = $('#stage');
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || !this.canSend()) return;
      depth++;
      stage.classList.add('drop-target');
    });
    window.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        stage.classList.remove('drop-target');
      }
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      stage.classList.remove('drop-target');
      this.sendFiles(e.dataTransfer?.files);
    });
  }

  /**
   * Ctrl+V с картинкой или файлами в буфере (скриншот Win+Shift+S, «Копировать» в Проводнике) —
   * собеседнику. Картинка из буфера называется «image.png», переименовываем в «Скриншот <дата время>».
   * Обычный текст вставляется как обычно; в полях настроек вставка не перехватывается.
   */
  private bindPaste(): void {
    window.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      if ((e.target as Element | null)?.closest?.('dialog')) return;
      e.preventDefault();
      const stamp = fileStamp();
      this.sendFiles(
        files.map((f, i) =>
          f.type.startsWith('image/') && /^image\.\w+$/i.test(f.name)
            ? new File([f], `Скриншот ${stamp}${files.length > 1 ? ` (${i + 1})` : ''}.${f.type.split('/')[1].replace('jpeg', 'jpg')}`, { type: f.type })
            : f,
        ),
      );
    });
  }

  /** Картинка во весь размер поверх окна; закрывается щелчком или Esc */
  private viewImage(src: string, name: string): void {
    const img = $<HTMLImageElement>('#imageViewImg');
    img.src = src;
    img.alt = name;
    $('#imageViewName').textContent = name;
    $<HTMLDialogElement>('#imageView').showModal();
  }

  /** @param byKeyboard щелчок сделан Enter или пробелом */
  private onAction(button: HTMLButtonElement | null, byKeyboard: boolean): void {
    if (!button) return;
    const id = Number(button.dataset.id);
    const act = button.dataset.act;
    if (act === 'accept') void this.chat.accept(id);
    else if (act === 'reject') this.chat.reject(id);
    else if (act === 'cancel') this.chat.cancel(id);
    else if (act === 'reveal') this.chat.reveal(id);
    else if (act === 'react') this.togglePicker(button, id, byKeyboard);
    else if (act === 'toggle-reaction') this.toggleReaction(id, button.dataset.key ?? '');
  }

  private toggleReaction(id: number, key: string): void {
    if (!this.chat.toggleReaction(id, key)) toast('На одно сообщение — не больше 8 реакций', 'warn', 2500);
  }

  private togglePicker(anchor: HTMLElement, id: number, byKeyboard: boolean): void {
    if (this.pickerFor === id) return this.closePicker();
    this.pickerFor = id;
    this.pickerByKeyboard = byKeyboard;
    const root = this.pickerRoot;
    root.hidden = false;
    this.picker.render();
    const a = anchor.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const margin = 8;
    root.style.left = `${Math.max(margin, Math.min(window.innerWidth - box.width - margin, a.right - box.width))}px`;
    // Не заезжать на верхнюю панель: там перетаскивание окна и его кнопки. Во весь экран панели нет
    const minTop = document.body.classList.contains('fs') ? margin : $('.topbar').getBoundingClientRect().bottom + margin;
    const above = a.top - box.height - 6;
    root.style.top = `${above >= minTop ? above : Math.max(minTop, Math.min(window.innerHeight - box.height - margin, a.bottom + 6))}px`;
    // Выбор стоит в конце документа: с клавиатуры до него иначе не дойти
    if (byKeyboard) root.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  /** @param restoreFocus вернуть фокус на кнопку сообщения, если выбор открывали с клавиатуры */
  private closePicker(restoreFocus = false): void {
    const id = this.pickerFor;
    this.pickerFor = null;
    this.pickerRoot.hidden = true;
    if (restoreFocus && this.pickerByKeyboard && id !== null) this.nodes.get(id)?.querySelector<HTMLElement>('.reaction-add')?.focus({ preventScroll: true });
    this.pickerByKeyboard = false;
  }

  private pickReaction(key: string): void {
    const id = this.pickerFor;
    this.closePicker(true);
    if (id !== null && !this.chat.items.find((i) => i.id === id)?.reactions?.get(key)?.me) this.toggleReaction(id, key);
  }

  private onReaction(item: ChatItem, key: string, who: 'me' | 'peer', on: boolean, silent: boolean): void {
    if (on && !silent) this.freshReactions.add(`${item.id}:${key}`);
    this.renderItem(item, true);
    if (who === 'peer' && on && !silent && !this.open) this.notifyReaction(item, key);
  }

  /** Реакция при закрытой панели: короткое уведомление без содержимого спойлеров; частые — схлопываются */
  private notifyReaction(item: ChatItem, key: string): void {
    const now = performance.now();
    if (now - this.lastReactionToast < REACTION_TOAST_MS) return;
    this.lastReactionToast = now;
    const target = item.kind === 'msg' ? `«${hideSpoilers(item.text).slice(0, 60)}»` : `файл «${item.name}»`;
    toast(`${this.peerName()}: ${this.reactions.label(key)} на ${target}`, 'info', 3500, { label: 'Открыть чат', onClick: () => this.toggle(true) });
  }

  /** Файл реакции дошёл или вытеснен: перерисовать сообщения с этой реакцией */
  private refreshReaction(key: string): void {
    for (const item of this.chat.items) if (item.reactions?.has(key)) this.renderItem(item, true);
  }

  private onChange(item: ChatItem | null): void {
    this.renderStatus();
    if (!item) {
      for (const it of this.chat.items) this.renderItem(it);
      return;
    }
    const isNew = !this.nodes.has(item.id);
    this.renderItem(item);
    if (isNew && !item.mine) this.notify(item);
  }

  /** Входящее при закрытой панели: счётчик и уведомление */
  private notify(item: ChatItem): void {
    if (this.open) return;
    this.unread++;
    this.renderBadge();
    const who = this.peerName();
    if (item.kind === 'msg') toast(`${who}: ${hideSpoilers(item.text).slice(0, 140)}`, 'info', 6000, { label: 'Ответить', onClick: () => this.toggle(true) });
    else if (item.auto) toast(`${who} прислал картинку «${item.name}»`, 'info', 6000, { label: 'Открыть чат', onClick: () => this.toggle(true) });
    else toast(`${who} предлагает файл «${item.name}» (${formatBytes(item.size)})`, 'info', 0, { label: 'Открыть чат', onClick: () => this.toggle(true) });
  }

  private renderBadge(): void {
    const badge = $('#chatBadge');
    badge.hidden = this.unread === 0;
    badge.textContent = this.unread > 99 ? '99+' : String(this.unread);
  }

  private renderStatus(): void {
    $('#chatStatus').textContent = this.chat.connected ? '' : 'нет связи — отправится позже';
  }

  /** Включает кнопку чата, когда есть с кем говорить */
  setAvailable(available: boolean): void {
    $<HTMLButtonElement>('#btnChat').disabled = !available && this.chat.items.length === 0;
  }

  /** @param reactionOnly изменились только реакции: своё сообщение не должно прокручивать ленту вниз */
  private renderItem(item: ChatItem, reactionOnly = false): void {
    const list = $('#chatList');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    let node = this.nodes.get(item.id);
    if (!node) {
      node = document.createElement('div');
      this.nodes.set(item.id, node);
      // Аватарка живёт рядом с пузырём: пузырь перерисовывается целиком, а её картинка не должна пересоздаваться
      const row = document.createElement('div');
      row.className = `chat-row${item.mine ? ' mine' : ''}`;
      row.append(this.messageAvatar(item.mine ? 'me' : 'peer'), node);
      list.append(row);
    }
    node.className = `chat-item${item.mine ? ' mine' : ''}${item.pending ? ' pending' : ''}`;
    if (node.querySelector('.rx-hover-live')) stopHoverPreview(); // mouseleave с убранного узла не придёт
    // Кнопки пересоздаются целиком: фокус возвращается на такую же кнопку, чтобы с клавиатуры не терялось место
    const focused = node.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset : null;
    const focusAct = focused?.act;
    const focusKey = focused?.key;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${item.mine ? 'Вы' : (this.sealedAuthors.get(item.id) ?? this.peerName())} · ${time(item.ts)}${item.pending ? ' · ждёт связи' : ''}`;
    node.replaceChildren(meta, ...(item.kind === 'msg' ? this.messageBody(item) : this.fileBody(item)), ...this.reactionRow(item), this.reactionAddButton(item));
    if (focusAct) {
      const buttons = [...node.querySelectorAll<HTMLElement>('button[data-act]')];
      (buttons.find((b) => b.dataset.act === focusAct && b.dataset.key === focusKey) ?? node.querySelector<HTMLElement>('.reaction-add'))?.focus({ preventScroll: true });
    }
    if (atBottom || (item.mine && !reactionOnly)) this.scrollDown();
  }

  /** Кнопка, которая появляется при наведении на сообщение */
  private reactionAddButton(item: ChatItem): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reaction-add';
    button.title = 'Поставить реакцию';
    button.innerHTML = iconSvg('smile');
    Object.assign(button.dataset, { act: 'react', id: String(item.id) });
    return button;
  }

  /** Чипы под сообщением: реакция и счётчик, своя подсвечена; щелчок ставит или снимает */
  private reactionRow(item: ChatItem): HTMLElement[] {
    if (!item.reactions?.size) return [];
    const row = document.createElement('div');
    row.className = 'reaction-row';
    for (const [key, marks] of item.reactions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      // Новая реакция: чип появляется один раз с анимацией, у встроенной ещё и своя анимация эмодзи
      const fresh = this.freshReactions.delete(`${item.id}:${key}`);
      const builtin = isBuiltinReaction(key);
      const pop = fresh ? ` pop${builtin ? ` ${reactionAnimClass(key)}` : ''}` : '';
      chip.className = `reaction-chip${marks.me ? ' mine' : ''}${pop}`;
      if (fresh) {
        // Класс снимается сразу: иначе выход панели из display: none запускал бы анимацию заново при каждом открытии чата
        const finish = (e: AnimationEvent) => {
          if (e.type === 'animationend' && builtin && e.target === chip) return; // у эмодзи анимация длиннее, чем у чипа
          chip.classList.remove('pop', reactionAnimClass(key));
        };
        chip.addEventListener('animationend', finish);
        chip.addEventListener('animationcancel', finish);
      }
      chip.title = this.reactions.label(key);
      Object.assign(chip.dataset, { act: 'toggle-reaction', id: String(item.id), key });
      const count = document.createElement('span');
      count.className = 'reaction-count';
      count.textContent = String(Number(marks.me) + Number(marks.peer));
      chip.append(reactionGlyph(key, this.reactions), count);
      if (!builtin) bindHoverPreview(chip, key, this.reactions); // в чипе статичная картинка, живая — под курсором; заодно подгрузит файл
      row.append(chip);
    }
    return [row];
  }

  private messageAvatar(who: AvatarWho): HTMLElement {
    const el = document.createElement('span');
    el.className = 'avatar avatar-chat';
    el.dataset.who = who;
    const { media, name } = this.avatar(who);
    renderAvatarThumb(el, avatarThumbSrc(media), name, media?.crop);
    return el;
  }

  /** Собеседник ушёл или сменился: его сообщения остаются за ним — с его именем и буквой, без аватарки */
  sealPeerHistory(name: string): void {
    for (const item of this.chat.items) if (!item.mine && !this.sealedAuthors.has(item.id)) this.sealedAuthors.set(item.id, name);
    for (const el of $('#chatList').querySelectorAll<HTMLElement>('.avatar[data-who="peer"]')) {
      delete el.dataset.who; // дальше updateAvatars эти кружки не трогает
      renderAvatarThumb(el, null, name);
    }
  }

  /** Аватарка или имя сменились: обновляет кружки у всех сообщений */
  updateAvatars(): void {
    for (const who of ['me', 'peer'] as const) {
      const { media, name } = this.avatar(who);
      const src = avatarThumbSrc(media);
      const key = `${src ?? ''}|${name}`;
      const crop = media?.crop;
      const circles = () => $('#chatList').querySelectorAll<HTMLElement>(`.avatar[data-who="${who}"]`);
      if (this.avatarKeys[who] !== key) {
        this.avatarKeys[who] = key;
        this.avatarCrops[who] = crop;
        for (const el of circles()) renderAvatarThumb(el, src, name, crop);
      } else if (this.avatarCrops[who] !== crop) {
        // Сменилось только кадрирование: GIF в кружках не должен начинаться сначала
        this.avatarCrops[who] = crop;
        if (crop) for (const el of circles()) updateAvatarThumbCrop(el, crop);
      }
    }
  }

  /** Текст со ссылками (открываются в браузере), спойлерами ||…|| и карточка первой ссылки */
  private messageBody(item: MessageItem): Node[] {
    const text = document.createElement('div');
    const linkify = (target: HTMLElement, s: string) => {
      let last = 0;
      for (const match of s.matchAll(URL_PATTERN)) {
        const at = match.index ?? 0;
        target.append(s.slice(last, at));
        const link = document.createElement('a');
        link.href = match[0];
        link.textContent = match[0];
        link.className = 'chat-link';
        link.title = 'Открыть в браузере';
        target.append(link);
        last = at + match[0].length;
      }
      target.append(s.slice(last));
    };
    let last = 0;
    let n = 0;
    for (const match of item.text.matchAll(SPOILER_PATTERN)) {
      const at = match.index ?? 0;
      linkify(text, item.text.slice(last, at));
      const key = `${item.id}:${n++}`;
      const spoiler = document.createElement('span');
      spoiler.className = `spoiler${this.revealed.has(key) ? ' revealed' : ''}`;
      spoiler.dataset.spoiler = key;
      spoiler.title = 'Спойлер — щёлкните, чтобы показать';
      linkify(spoiler, match[1]);
      text.append(spoiler);
      last = at + match[0].length;
    }
    linkify(text, item.text.slice(last));
    const parts: Node[] = [text];
    const p = item.preview;
    if (p) {
      const card = document.createElement('a');
      card.href = p.url;
      card.className = 'link-card';
      card.title = p.url;
      if (p.image) {
        const media = document.createElement('div');
        media.className = `link-card-media${p.video ? ' video' : ''}`;
        const img = document.createElement('img');
        img.src = p.image;
        img.alt = '';
        media.append(img);
        card.append(media);
      }
      const body = document.createElement('div');
      body.className = 'link-card-body';
      for (const [cls, value] of [['link-card-site', p.site], ['link-card-title', p.title], ['link-card-desc', p.description]] as const) {
        if (!value) continue;
        const line = document.createElement('div');
        line.className = cls;
        line.textContent = value;
        body.append(line);
      }
      card.append(body);
      parts.push(card);
    }
    return parts;
  }

  private fileBody(t: Transfer): HTMLElement[] {
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = `${t.name} · ${formatBytes(t.size)}`;
    const parts: HTMLElement[] = [];
    if (t.preview) {
      const img = document.createElement('img');
      img.className = 'chat-thumb';
      img.src = t.preview;
      img.alt = t.name;
      img.title = 'Открыть во весь размер (Ctrl+C — скопировать)';
      if (t.spoiler) {
        const key = `f${t.id}`;
        const wrap = document.createElement('div');
        wrap.className = `spoiler spoiler-media${this.revealed.has(key) ? ' revealed' : ''}`;
        wrap.dataset.spoiler = key;
        wrap.title = 'Спойлер — щёлкните, чтобы показать';
        wrap.append(img);
        parts.push(wrap);
      } else {
        parts.push(img);
      }
    }
    parts.push(name);
    const done = t.mine ? t.sent : t.received;
    if (['sending', 'receiving', 'finishing'].includes(t.status)) {
      const bar = document.createElement('progress');
      bar.max = Math.max(1, t.size);
      bar.value = done;
      parts.push(bar);
    }
    const status = document.createElement('div');
    status.className = 'meta';
    const speed = t.speed > 0 && ['sending', 'receiving'].includes(t.status) ? ` · ${formatBytes(t.speed)}/с` : '';
    const progress = ['sending', 'receiving'].includes(t.status) ? ` · ${formatBytes(done)} из ${formatBytes(t.size)}` : '';
    status.textContent = `${STATUS[t.status]?.(t) ?? t.status}${progress}${speed}`;
    parts.push(status);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const button = (act: string, label: string, primary = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      Object.assign(b.dataset, { act, id: String(t.id) });
      if (primary) b.className = 'primary';
      actions.append(b);
    };
    if (!t.mine && t.status === 'offered') {
      button('accept', 'Принять', true);
      button('reject', 'Отклонить');
    } else if (['offered', 'sending', 'finishing', 'receiving'].includes(t.status)) {
      button('cancel', 'Отменить');
    } else if (!t.mine && t.status === 'done') {
      button('reveal', 'Показать в папке');
    }
    if (actions.children.length) parts.push(actions);
    return parts;
  }

  private scrollDown(): void {
    const list = $('#chatList');
    list.scrollTop = list.scrollHeight;
  }
}
