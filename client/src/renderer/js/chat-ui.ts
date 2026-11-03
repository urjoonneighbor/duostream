// Панель чата: сообщения, файлы с прогрессом, отправка (кнопка, Enter, перетаскивание файлов в окно).
import { $, toast } from './ui.ts';
import { URL_PATTERN, type Chat, type ChatItem, type MessageItem, type Transfer, type TransferStatus } from './chat.ts';

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

export class ChatPanel {
  private readonly chat: Chat;
  private readonly peerName: () => string;
  private readonly canSend: () => boolean;
  private unread = 0;
  private readonly nodes = new Map<number, HTMLElement>(); // id → элемент списка
  private readonly panel = $('#chatPanel');

  constructor(chat: Chat, { peerName, canSend }: { peerName: () => string; canSend: () => boolean }) {
    this.chat = chat;
    this.peerName = peerName;
    this.canSend = canSend;

    chat.on('change', ({ item }) => this.onChange(item));
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
    $('#chatList').addEventListener('click', (e) => {
      const target = e.target as Element;
      const link = target.closest<HTMLAnchorElement>('a.chat-link, a.link-card');
      if (link) {
        e.preventDefault(); // внутри окна переходы запрещены — открываем в браузере
        void window.duo.openLink(link.href);
        return;
      }
      const thumb = target.closest<HTMLImageElement>('img.chat-thumb');
      if (thumb) this.viewImage(thumb.src, thumb.alt);
      else this.onAction(target.closest<HTMLButtonElement>('button[data-act]'));
    });
    $('#imageView').addEventListener('click', () => $<HTMLDialogElement>('#imageView').close());
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

  private sendInput(): void {
    const input = $<HTMLTextAreaElement>('#chatInput');
    if (!input.value.trim()) return;
    this.chat.sendText(input.value);
    input.value = '';
  }

  private sendFiles(files: Iterable<File> | null | undefined): void {
    const list = [...(files ?? [])];
    if (!list.length) return;
    if (!this.canSend()) {
      toast('Файлы можно отправить, когда собеседник подключён', 'warn');
      return;
    }
    this.chat.sendFiles(list);
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
      const stamp = new Date().toLocaleString('sv-SE').replace(/:/g, '-'); // 2026-10-27 22-45-10
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

  private onAction(button: HTMLButtonElement | null): void {
    if (!button) return;
    const id = Number(button.dataset.id);
    const act = button.dataset.act;
    if (act === 'accept') void this.chat.accept(id);
    else if (act === 'reject') this.chat.reject(id);
    else if (act === 'cancel') this.chat.cancel(id);
    else if (act === 'reveal') this.chat.reveal(id);
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
    if (item.kind === 'msg') toast(`${who}: ${item.text.slice(0, 140)}`, 'info', 6000, { label: 'Ответить', onClick: () => this.toggle(true) });
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

  private renderItem(item: ChatItem): void {
    const list = $('#chatList');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    let node = this.nodes.get(item.id);
    if (!node) {
      node = document.createElement('div');
      this.nodes.set(item.id, node);
      list.append(node);
    }
    node.className = `chat-item${item.mine ? ' mine' : ''}${item.pending ? ' pending' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${item.mine ? 'Вы' : this.peerName()} · ${time(item.ts)}${item.pending ? ' · ждёт связи' : ''}`;
    node.replaceChildren(meta, ...(item.kind === 'msg' ? this.messageBody(item) : this.fileBody(item)));
    if (atBottom || item.mine) this.scrollDown();
  }

  /** Текст со ссылками (открываются в браузере) и карточка первой ссылки */
  private messageBody(item: MessageItem): Node[] {
    const text = document.createElement('div');
    let last = 0;
    for (const match of item.text.matchAll(URL_PATTERN)) {
      const at = match.index ?? 0;
      text.append(item.text.slice(last, at));
      const link = document.createElement('a');
      link.href = match[0];
      link.textContent = match[0];
      link.className = 'chat-link';
      link.title = 'Открыть в браузере';
      text.append(link);
      last = at + match[0].length;
    }
    text.append(item.text.slice(last));
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
      img.title = 'Открыть во весь размер';
      parts.push(img);
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
