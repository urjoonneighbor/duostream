// Панель чата: сообщения, файлы с прогрессом, отправка (кнопка, Enter, перетаскивание файлов в окно).
import { $, toast } from './ui.js';

const STATUS = {
  offered: (t) => (t.mine ? 'ждёт, пока собеседник примет' : 'собеседник предлагает файл'),
  sending: () => 'отправка',
  finishing: () => 'отправлено, ждём подтверждения',
  receiving: () => 'приём',
  done: (t) => (t.mine ? 'доставлен' : 'сохранён'),
  rejected: (t) => (t.mine ? 'собеседник отказался' : 'отклонён'),
  cancelled: (t) => `не передан: ${t.error ?? 'отменено'}`,
  error: (t) => `ошибка: ${t.error ?? ''}`,
};

export function formatBytes(n) {
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

const time = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export class ChatPanel {
  /**
   * @param {import('./chat.js').Chat} chat
   * @param {{peerName:() => string, canSend:() => boolean}} options
   */
  constructor(chat, { peerName, canSend }) {
    this.chat = chat;
    this.peerName = peerName;
    this.canSend = canSend;
    this.unread = 0;
    this.nodes = new Map(); // id → элемент списка
    this.panel = $('#chatPanel');

    chat.addEventListener('change', (e) => this.onChange(e.detail.item));
    $('#btnChat').addEventListener('click', () => this.toggle());
    $('#chatClose').addEventListener('click', () => this.toggle(false));
    $('#chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendInput();
    });
    $('#chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendInput();
      }
    });
    $('#chatAttach').addEventListener('click', () => $('#chatFile').click());
    $('#chatFile').addEventListener('change', (e) => {
      this.sendFiles(e.target.files);
      e.target.value = '';
    });
    $('#chatList').addEventListener('click', (e) => {
      const thumb = e.target.closest('img.chat-thumb');
      if (thumb) this.viewImage(thumb.src, thumb.alt);
      else this.onAction(e.target.closest('button[data-act]'));
    });
    $('#imageView').addEventListener('click', () => $('#imageView').close());
    this.bindDrop();
    this.bindPaste();
  }

  get open() {
    return !this.panel.hidden;
  }

  toggle(show = !this.open) {
    this.panel.hidden = !show;
    $('#stage').classList.toggle('chat-open', show);
    if (show) {
      this.unread = 0;
      this.renderBadge();
      $('#chatInput').focus();
      this.scrollDown();
    }
  }

  sendInput() {
    const input = $('#chatInput');
    if (!input.value.trim()) return;
    this.chat.sendText(input.value);
    input.value = '';
  }

  sendFiles(files) {
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
  bindDrop() {
    const stage = $('#stage');
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
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
      this.sendFiles(e.dataTransfer.files);
    });
  }

  /**
   * Ctrl+V с картинкой или файлами в буфере (скриншот Win+Shift+S, «Копировать» в Проводнике) —
   * собеседнику. Картинка из буфера называется «image.png», переименовываем в «Скриншот <дата время>».
   * Обычный текст вставляется как обычно; в полях настроек вставка не перехватывается.
   */
  bindPaste() {
    window.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      if (e.target.closest?.('dialog')) return;
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
  viewImage(src, name) {
    const img = $('#imageViewImg');
    img.src = src;
    img.alt = name;
    $('#imageViewName').textContent = name;
    $('#imageView').showModal();
  }

  onAction(button) {
    if (!button) return;
    const id = Number(button.dataset.id);
    const act = button.dataset.act;
    if (act === 'accept') this.chat.accept(id);
    else if (act === 'reject') this.chat.reject(id);
    else if (act === 'cancel') this.chat.cancel(id);
    else if (act === 'reveal') this.chat.reveal(id);
  }

  onChange(item) {
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
  notify(item) {
    if (this.open) return;
    this.unread++;
    this.renderBadge();
    const who = this.peerName();
    if (item.kind === 'msg') toast(`${who}: ${item.text.slice(0, 140)}`, 'info', 6000, { label: 'Ответить', onClick: () => this.toggle(true) });
    else if (item.auto) toast(`${who} прислал картинку «${item.name}»`, 'info', 6000, { label: 'Открыть чат', onClick: () => this.toggle(true) });
    else toast(`${who} предлагает файл «${item.name}» (${formatBytes(item.size)})`, 'info', 0, { label: 'Открыть чат', onClick: () => this.toggle(true) });
  }

  renderBadge() {
    const badge = $('#chatBadge');
    badge.hidden = this.unread === 0;
    badge.textContent = this.unread > 99 ? '99+' : String(this.unread);
  }

  renderStatus() {
    $('#chatStatus').textContent = this.chat.connected ? '' : 'нет связи — отправится позже';
  }

  /** Включает кнопку чата, когда есть с кем говорить */
  setAvailable(available) {
    $('#btnChat').disabled = !available && this.chat.items.length === 0;
  }

  renderItem(item) {
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
    node.replaceChildren(meta, ...(item.kind === 'msg' ? [document.createTextNode(item.text)] : this.fileBody(item)));
    if (atBottom || item.mine) this.scrollDown();
  }

  fileBody(t) {
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = `${t.name} · ${formatBytes(t.size)}`;
    const parts = [];
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
    const button = (act, label, primary = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      Object.assign(b.dataset, { act, id: t.id });
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

  scrollDown() {
    const list = $('#chatList');
    list.scrollTop = list.scrollHeight;
  }
}
