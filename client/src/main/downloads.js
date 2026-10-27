'use strict';
/**
 * Приём файлов из чата: запись по кускам прямо на диск (файл любого размера не держится в памяти).
 * Папка — «Загрузки\DuoStream». Имя от собеседника очищается: только имя файла, без пути и запрещённых
 * символов; если такой файл уже есть — «имя (2).расш».
 */
const fs = require('node:fs');
const path = require('node:path');

const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function safeName(name) {
  let base = path.basename(String(name ?? '')).replace(FORBIDDEN, '_').replace(/[. ]+$/, '').slice(0, 180);
  if (!base || RESERVED.test(base)) base = `файл_${Date.now()}`;
  return base;
}

class Downloads {
  /** @param {() => string} dir папка загрузок */
  constructor(dir) {
    this.dir = dir;
    this.files = new Map(); // id → {handle, path}
    this.nextId = 0;
  }

  /** @returns {Promise<{id:number, path:string}>} */
  async create(name) {
    const dir = this.dir();
    await fs.promises.mkdir(dir, { recursive: true });
    const clean = safeName(name);
    const ext = path.extname(clean);
    const stem = clean.slice(0, clean.length - ext.length);
    for (let n = 1; n < 1000; n++) {
      const file = path.join(dir, n === 1 ? clean : `${stem} (${n})${ext}`);
      try {
        const handle = await fs.promises.open(file, 'wx'); // не перезаписываем существующие
        const id = ++this.nextId;
        this.files.set(id, { handle, path: file });
        return { id, path: file };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    throw new Error('не удалось подобрать имя файла');
  }

  async write(id, offset, data) {
    const f = this.files.get(id);
    if (!f) throw new Error('файл не открыт');
    const buffer = Buffer.from(data);
    await f.handle.write(buffer, 0, buffer.length, offset);
  }

  async close(id) {
    const f = this.files.get(id);
    if (!f) return;
    this.files.delete(id);
    await f.handle.close();
  }

  /** Отмена: закрыть и удалить недокачанный файл */
  async abort(id) {
    const f = this.files.get(id);
    if (!f) return;
    this.files.delete(id);
    await f.handle.close().catch(() => {});
    await fs.promises.rm(f.path, { force: true });
  }

  async closeAll() {
    for (const id of [...this.files.keys()]) await this.abort(id);
  }
}

/**
 * Отправка файлов из чата: чтение кусками с диска обычным fs. File.slice() в Chromium отказывает
 * (NotReadableError), если файл после выбора изменился, лежит в облачной папке или его держит другая
 * программа; fs читает такие файлы, как Проводник. Путь даёт preload (webUtils.getPathForFile) только
 * для файлов, которые пользователь сам выбрал или перетащил.
 */
class Uploads {
  constructor() {
    this.files = new Map(); // id → handle
    this.nextId = 0;
  }

  async open(file) {
    const handle = await fs.promises.open(String(file), 'r');
    const id = ++this.nextId;
    this.files.set(id, handle);
    return id;
  }

  async read(id, offset, length) {
    const handle = this.files.get(id);
    if (!handle) throw new Error('файл не открыт');
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, 1 << 20)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead);
  }

  async close(id) {
    const handle = this.files.get(id);
    if (!handle) return;
    this.files.delete(id);
    await handle.close().catch(() => {});
  }

  async closeAll() {
    for (const id of [...this.files.keys()]) await this.close(id);
  }
}

module.exports = { Downloads, Uploads };
