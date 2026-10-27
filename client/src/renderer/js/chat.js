// Чат и передача файлов любого размера — напрямую P2P, каналами данных той же WebRTC-сессии.
//
// Канал «chat» (JSON): сообщения и управление передачей. Канал «file» (двоичный): куски по 64 КБ
// с заголовком [id передачи: uint32][смещение: float64]. Файл читается с диска кусками (File.slice)
// и так же кусками пишется у получателя (src/main/downloads.js) — в память целиком не грузится.
//
// Сессию WebRTC приложение иногда пересоздаёт (рост окна трансляции, смена кодека, обрыв сети).
// Передачи это переживают: на новых каналах получатель сообщает, сколько байт у него уже есть
// (file-accept с offset), и отправитель продолжает с этого места. Текст, набранный без связи,
// уходит, как только каналы откроются.
//
// Картинки до 25 МБ (скриншоты) показываются в чате миниатюрой: у отправителя — из самого файла,
// у получателя — из пришедших кусков (они и так проходят через интерфейс). Такие картинки получатель
// принимает сам, без «Принять», — как в мессенджерах; остальные файлы ждут согласия.

const CHUNK = 64 * 1024;
const HEADER = 12;
const HIGH_WATER = 4 * 1024 * 1024; // не держать в очереди канала больше 4 МБ
const LOW_WATER = 1024 * 1024;

const PREVIEW_MAX = 25 * 1024 * 1024;
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

const randomId = () => crypto.getRandomValues(new Uint32Array(1))[0];

/** MIME картинки, которую показываем миниатюрой, по имени и размеру; иначе null */
function previewType(name, size) {
  const ext = /\.(\w+)$/.exec(String(name))?.[1]?.toLowerCase();
  return size > 0 && size <= PREVIEW_MAX ? (IMAGE_TYPES[ext] ?? null) : null;
}

export class Chat extends EventTarget {
  constructor() {
    super();
    /** @type {Array<object>} сообщения и передачи по порядку */
    this.items = [];
    this.transfers = new Map(); // id → передача (входящая или исходящая)
    this.outbox = []; // сообщения, набранные без связи
    this.channels = null; // {chat, file}, когда оба открыты
    this.session = null;
  }

  get connected() {
    return Boolean(this.channels);
  }

  changed(item = null) {
    this.dispatchEvent(new CustomEvent('change', { detail: { item } }));
  }

  // ---------------- каналы ----------------

  /** Новая WebRTC-сессия: ждём открытия её каналов */
  attach(session) {
    this.detach();
    this.session = session;
    const { chatChannel: chat, fileChannel: file } = session;
    file.bufferedAmountLowThreshold = LOW_WATER;
    const ready = () => {
      if (this.session !== session || chat.readyState !== 'open' || file.readyState !== 'open') return;
      this.channels = { chat, file };
      this.onOpen();
    };
    chat.onopen = ready;
    file.onopen = ready;
    chat.onclose = () => this.session === session && this.detach();
    chat.onmessage = (e) => this.session === session && this.onControl(e.data);
    file.onmessage = (e) => this.session === session && this.onChunk(e.data);
    ready();
  }

  detach() {
    const was = this.connected;
    this.session = null;
    this.channels = null;
    if (was) this.changed();
  }

  onOpen() {
    for (const msg of this.outbox.splice(0)) this.sendControl(msg);
    for (const item of this.items) if (item.pending) item.pending = false;
    for (const t of this.transfers.values()) {
      // Возобновление: получатель сообщает, сколько уже записал
      if (!t.mine && t.status === 'receiving') this.sendControl({ t: 'file-accept', id: t.id, offset: t.received });
      // Подтверждение могло потеряться при обрыве — повторяем, иначе отправитель ждёт его вечно
      if (!t.mine && t.status === 'done') this.sendControl({ t: 'file-received', id: t.id });
      // Предложение файла, которое собеседник мог не получить
      if (t.mine && t.status === 'offered') this.sendControl({ t: 'file-offer', id: t.id, name: t.name, size: t.size });
    }
    this.changed();
  }

  sendControl(msg) {
    if (!this.channels) return false;
    this.channels.chat.send(JSON.stringify(msg));
    return true;
  }

  // ---------------- сообщения ----------------

  sendText(text) {
    const value = String(text).trim();
    if (!value) return;
    const msg = { t: 'msg', id: randomId(), text: value.slice(0, 20_000), ts: Date.now() };
    this.items.push({ kind: 'msg', id: msg.id, mine: true, text: msg.text, ts: msg.ts, pending: !this.connected });
    if (!this.sendControl(msg)) this.outbox.push(msg);
    this.changed();
  }

  onControl(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const t = this.transfers.get(msg.id);
    switch (msg.t) {
      case 'msg': {
        const item = { kind: 'msg', id: msg.id, mine: false, text: String(msg.text ?? '').slice(0, 20_000), ts: Number(msg.ts) || Date.now() };
        this.items.push(item);
        this.changed(item);
        break;
      }
      case 'file-offer':
        if (t) return; // повторное предложение после переподключения
        {
          const name = String(msg.name ?? 'файл');
          const size = Number(msg.size) || 0;
          const imageType = previewType(name, size);
          this.addTransfer({ id: msg.id, mine: false, name, size, status: 'offered', imageType, auto: Boolean(imageType) });
          if (imageType) this.accept(msg.id); // картинку принимаем сразу — её покажем в чате
        }
        break;
      case 'file-accept':
        if (t?.mine && ['offered', 'sending', 'finishing'].includes(t.status)) this.startSending(t, Number(msg.offset) || 0);
        break;
      case 'file-reject':
        if (t?.mine) this.setStatus(t, 'rejected');
        break;
      case 'file-cancel':
        if (t && !['done', 'rejected', 'cancelled'].includes(t.status)) this.finishCancelled(t, 'собеседник отменил');
        break;
      case 'file-received':
        if (t?.mine) this.setStatus(t, 'done');
        break;
      default:
        break;
    }
  }

  // ---------------- файлы: отправка ----------------

  /** @param {Iterable<File>} files */
  sendFiles(files) {
    for (const file of files) {
      const preview = previewType(file.name, file.size) ? URL.createObjectURL(file) : null;
      const t = this.addTransfer({ id: randomId(), mine: true, name: file.name, size: file.size, status: 'offered', file, preview });
      this.sendControl({ t: 'file-offer', id: t.id, name: t.name, size: t.size });
    }
  }

  startSending(t, offset) {
    t.sent = Math.min(Math.max(0, offset), t.size);
    this.setStatus(t, 'sending');
    this.pump(t);
  }

  async pump(t) {
    const channels = this.channels;
    const token = (t.token = {});
    const alive = () => this.channels === channels && t.token === token && t.status === 'sending';
    while (t.sent < t.size) {
      if (!alive()) return;
      if (channels.file.bufferedAmount > HIGH_WATER) {
        await new Promise((resolve) => {
          channels.file.addEventListener('bufferedamountlow', resolve, { once: true });
          channels.file.addEventListener('close', resolve, { once: true });
        });
        continue;
      }
      const end = Math.min(t.size, t.sent + CHUNK);
      let data;
      try {
        data = await this.readChunk(t, t.sent, end);
      } catch (err) {
        if (!alive()) return;
        this.sendControl({ t: 'file-cancel', id: t.id });
        this.finishCancelled(t, `не удалось прочитать файл: ${err?.message ?? err}`);
        return;
      }
      if (!alive()) return;
      if (data.byteLength !== end - t.sent) {
        this.sendControl({ t: 'file-cancel', id: t.id });
        this.finishCancelled(t, 'файл изменился во время отправки');
        return;
      }
      const packet = new Uint8Array(HEADER + data.byteLength);
      const view = new DataView(packet.buffer);
      view.setUint32(0, t.id);
      view.setFloat64(4, t.sent);
      packet.set(new Uint8Array(data), HEADER);
      try {
        channels.file.send(packet.buffer);
      } catch {
        return; // канал закрылся — продолжим на следующем по file-accept
      }
      t.sent = end;
      this.progress(t, t.sent);
    }
    if (alive()) this.setStatus(t, 'finishing'); // всё отправлено, ждём подтверждения получателя
  }

  /**
   * Кусок файла [from, to): с диска через главный процесс (src/main/downloads.js, Uploads) —
   * File.slice() отказывает, если файл изменился после выбора, облачный или занят другой программой.
   * Если пути на диске нет (вставка из буфера обмена), читаем через File.
   */
  async readChunk(t, from, to) {
    if (t.readId === undefined) t.readId = await window.duo.files.openRead(t.file).catch(() => null);
    if (t.readId === null) return t.file.slice(from, to).arrayBuffer();
    const bytes = await window.duo.files.read(t.readId, from, to - from);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  closeReader(t) {
    if (t.readId) window.duo.files.closeRead(t.readId).catch(() => {});
    t.readId = undefined;
  }

  // ---------------- файлы: приём ----------------

  async accept(id) {
    const t = this.transfers.get(id);
    if (!t || t.mine || t.status !== 'offered') return;
    try {
      const { id: fileId, path } = await window.duo.files.create(t.name);
      Object.assign(t, { fileId, path, received: 0, writing: Promise.resolve(), chunks: t.imageType ? [] : null });
      this.setStatus(t, 'receiving');
      this.sendControl({ t: 'file-accept', id: t.id, offset: 0 });
      if (t.size === 0) this.completeReceive(t);
    } catch (err) {
      t.error = err.message;
      this.setStatus(t, 'error');
      this.sendControl({ t: 'file-cancel', id: t.id });
    }
  }

  reject(id) {
    const t = this.transfers.get(id);
    if (!t || t.mine || t.status !== 'offered') return;
    this.setStatus(t, 'rejected');
    this.sendControl({ t: 'file-reject', id: t.id });
  }

  onChunk(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER) return;
    const view = new DataView(buffer);
    const t = this.transfers.get(view.getUint32(0));
    const offset = view.getFloat64(4);
    // Только следующий по порядку кусок: остатки старого канала после возобновления пропускаем
    if (!t || t.mine || t.status !== 'receiving' || offset !== t.received) return;
    const data = buffer.slice(HEADER);
    t.received += data.byteLength;
    t.chunks?.push(data);
    t.writing = t.writing.then(() => window.duo.files.write(t.fileId, offset, data));
    t.writing.catch((err) => {
      if (t.status !== 'receiving') return;
      t.error = err.message;
      this.finishCancelled(t, `ошибка записи: ${err.message}`);
    });
    this.progress(t, t.received);
    if (t.received >= t.size) this.completeReceive(t);
  }

  async completeReceive(t) {
    try {
      await t.writing;
      await window.duo.files.close(t.fileId);
      if (t.chunks) t.preview = URL.createObjectURL(new Blob(t.chunks, { type: t.imageType }));
      t.chunks = null;
      this.setStatus(t, 'done');
      this.sendControl({ t: 'file-received', id: t.id });
    } catch (err) {
      t.error = err.message;
      this.setStatus(t, 'error');
    }
  }

  // ---------------- общее ----------------

  cancel(id) {
    const t = this.transfers.get(id);
    if (!t || ['done', 'rejected', 'cancelled', 'error'].includes(t.status)) return;
    this.sendControl({ t: 'file-cancel', id: t.id });
    this.finishCancelled(t, 'отменено');
  }

  finishCancelled(t, reason) {
    t.token = null;
    t.chunks = null;
    t.error = reason;
    if (!t.mine && t.fileId) window.duo.files.abort(t.fileId); // недокачанный файл удаляем
    this.setStatus(t, 'cancelled');
  }

  reveal(id) {
    const t = this.transfers.get(id);
    if (t?.path) window.duo.files.reveal(t.path);
  }

  /** Отключились совсем: незавершённые передачи прерываем, недокачанное удаляем */
  interrupt() {
    for (const t of this.transfers.values()) {
      if (['offered', 'sending', 'finishing', 'receiving'].includes(t.status)) this.finishCancelled(t, 'соединение закрыто');
    }
    this.outbox = [];
    this.detach();
  }

  addTransfer(fields) {
    const t = { kind: 'file', sent: 0, received: 0, speed: 0, ts: Date.now(), ...fields, speedMark: { at: performance.now(), bytes: 0 } };
    this.transfers.set(t.id, t);
    this.items.push(t);
    this.changed(t);
    return t;
  }

  setStatus(t, status) {
    t.status = status;
    if (t.mine && ['done', 'rejected', 'cancelled', 'error'].includes(status)) this.closeReader(t);
    if (status === 'done') t.speed = 0;
    this.changed(t);
  }

  /** Прогресс и скорость (обновление интерфейса — не чаще 4 раз в секунду) */
  progress(t, bytes) {
    const now = performance.now();
    const mark = t.speedMark;
    if (now - mark.at < 250) return;
    t.speed = ((bytes - mark.bytes) * 1000) / (now - mark.at);
    t.speedMark = { at: now, bytes };
    this.changed(t);
  }
}
