'use strict';
/**
 * Журнал: один файл на день в <userData>/logs — duostream-ГГГГ-ММ-ДД.log (все запуски за день подряд,
 * каждый начинается строкой «===== запуск …»). Журналы прошлых дней сжимаются в .log.gz, архивы и картинки
 * кадров-выбросов старше 30 дней удаляются. В журнал идёт всё, что нужно для разбора проблемы постфактум:
 * версии и видеокарта, события подключения и ICE, смена кодека и энкодера, захват, сводка статистики
 * обеих сторон (раз в минуту и при важных изменениях), кадры-выбросы у зрителя, ошибки.
 * Пароли в журнал не пишутся. IP-адреса пишутся — без них не разобрать проблемы сети.
 *
 * console.* главного процесса тоже попадают в журнал; интерфейс пишет через IPC (log:write).
 */
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const KEEP_DAYS = 30;
const DAY_LOG = /^duostream-(\d{4}-\d{2}-\d{2})\.log$/;
// Журналы прежнего формата — файл на каждый запуск: duostream-2026-10-27-16-52-55.log
const OLD_LOG = /^duostream-(\d{4}-\d{2}-\d{2})-\d{2}-\d{2}-\d{2}\.log$/;

/** Местная дата ГГГГ-ММ-ДД: сутки журнала — по часам пользователя, а не по UTC */
function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

class Logger {
  constructor() {
    this.stream = null;
    this.file = null;
    this.dir = null;
    this.day = null;
    this.archiving = null;
  }

  /** @param {string} dir папка журналов */
  open(dir) {
    this.dir = dir;
    this.openDay(true);
  }

  /** Файл текущего дня (дописывается); журналы прошлых дней — в архив */
  openDay(launch = false) {
    fs.mkdirSync(this.dir, { recursive: true });
    const old = this.stream;
    this.day = localDay();
    this.file = path.join(this.dir, `duostream-${this.day}.log`);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    if (launch) this.stream.write(`\n===== запуск ${new Date().toISOString()} =====\n`);
    // Вчерашний файл архивируется, только когда в него дописано всё
    if (old) old.end(() => this.archive());
    else this.archive();
  }

  /**
   * Файл журнала удалили, пока приложение работает (Windows это позволяет, запись уходит в никуда) —
   * заводим его заново. @returns {string|null} путь к файлу
   */
  ensureFile() {
    if (!this.dir) return null;
    if (this.file && fs.existsSync(this.file)) return this.file;
    this.openDay();
    this.info('main', 'файл журнала был удалён — продолжение в новом файле');
    return this.file;
  }

  /** Путь для картинки кадра-выброса: рядом с журналом, в имени дата и время */
  imagePath(n) {
    const time = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
    return path.join(this.dir, `duostream-${this.day}-${time}-glitch-${n}.png`);
  }

  /** Папка для кадров отметки глюка: рядом с журналом, в имени дата, время и чьи кадры */
  framesDir(label) {
    const time = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
    return path.join(this.dir, `duostream-${this.day}-${time}-${label}`);
  }

  /** Сжать журналы прошлых дней в .gz, удалить архивы и картинки старше KEEP_DAYS (в фоне) */
  archive() {
    if (this.archiving) return this.archiving;
    this.archiving = this.archiveNow()
      .catch((err) => this.warn('main', 'архивация журналов:', err.message))
      .finally(() => (this.archiving = null));
    return this.archiving;
  }

  async archiveNow() {
    const dir = this.dir;
    const cutoff = localDay(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    const files = await fs.promises.readdir(dir);
    // Недожатый архив (приложение закрыли во время сжатия) — исходники целы, сожмём заново
    for (const f of files) if (f.endsWith('.log.gz.tmp')) await fs.promises.rm(path.join(dir, f), { force: true });
    // Журналы прежнего формата за один день склеиваются в общий архив дня
    const byDay = new Map();
    for (const f of files) {
      const m = DAY_LOG.exec(f) ?? OLD_LOG.exec(f);
      if (!m || m[1] >= this.day) continue;
      if (!byDay.has(m[1])) byDay.set(m[1], []);
      byDay.get(m[1]).push(path.join(dir, f));
    }
    for (const [day, sources] of byDay) {
      sources.sort();
      let target = path.join(dir, `duostream-${day}.log.gz`);
      if (fs.existsSync(target)) target = path.join(dir, `duostream-${day}-${Date.now()}.log.gz`);
      const tmp = `${target}.tmp`;
      await pipeline(
        async function* () {
          for (const src of sources) yield* fs.createReadStream(src);
        },
        zlib.createGzip({ level: 9 }),
        fs.createWriteStream(tmp),
      );
      await fs.promises.rename(tmp, target);
      for (const src of sources) await fs.promises.rm(src, { force: true });
    }
    // Старьё: архивы, картинки кадров-выбросов и папки кадров отметок глюка
    for (const f of files) {
      const m = /^duostream-(\d{4}-\d{2}-\d{2})(.*\.(log\.gz|png)|-\d{2}-\d{2}-\d{2}-[\w-]+)$/.exec(f);
      if (m && m[1] < cutoff) await fs.promises.rm(path.join(dir, f), { force: true, recursive: true });
    }
  }

  /**
   * @param {'info'|'warn'|'error'} level
   * @param {string} source откуда: main, ui, capture, server…
   */
  write(level, source, ...parts) {
    const text = parts.map((p) => (typeof p === 'string' ? p : util.inspect(p, { depth: 4, breakLength: 160 }))).join(' ');
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${text}\n`;
    if (this.stream && localDay() !== this.day) this.openDay(); // наступили новые сутки — новый файл
    this.stream?.write(line);
  }

  info(source, ...parts) {
    this.write('info', source, ...parts);
  }

  warn(source, ...parts) {
    this.write('warn', source, ...parts);
  }

  error(source, ...parts) {
    this.write('error', source, ...parts);
  }

  /** console.* главного процесса — ещё и в журнал */
  captureConsole() {
    for (const [method, level] of [
      ['log', 'info'],
      ['info', 'info'],
      ['warn', 'warn'],
      ['error', 'error'],
    ]) {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        original(...args);
        this.write(level, 'main', ...args);
      };
    }
  }

  close() {
    this.stream?.end();
    this.stream = null;
  }
}

module.exports = { log: new Logger(), localDay };
