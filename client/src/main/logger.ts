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
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const KEEP_DAYS = 30;
const DAY_LOG = /^duostream-(\d{4}-\d{2}-\d{2})\.log$/;
// Журналы прежнего формата — файл на каждый запуск: duostream-2026-10-27-16-52-55.log
const OLD_LOG = /^duostream-(\d{4}-\d{2}-\d{2})-\d{2}-\d{2}-\d{2}\.log$/;

export type LogLevel = 'info' | 'warn' | 'error';

/** Местная дата ГГГГ-ММ-ДД: сутки журнала — по часам пользователя, а не по UTC */
export function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

class Logger {
  stream: fs.WriteStream | null = null;
  file: string | null = null;
  dir: string | null = null;
  day: string | null = null;
  archiving: Promise<void> | null = null;

  /** @param dir папка журналов */
  open(dir: string): void {
    this.dir = dir;
    this.openDay(true);
  }

  /** Файл текущего дня (дописывается); журналы прошлых дней — в архив */
  openDay(launch = false): void {
    if (!this.dir) return;
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
   * заводим его заново. Возвращает путь к файлу.
   */
  ensureFile(): string | null {
    if (!this.dir) return null;
    if (this.file && fs.existsSync(this.file)) return this.file;
    this.openDay();
    this.info('main', 'файл журнала был удалён — продолжение в новом файле');
    return this.file;
  }

  /** Путь для картинки кадра-выброса: рядом с журналом, в имени дата и время */
  imagePath(n: number): string {
    const time = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
    return path.join(this.dir ?? '', `duostream-${this.day}-${time}-glitch-${n}.png`);
  }

  /** Папка для кадров отметки глюка: рядом с журналом, в имени дата, время и чьи кадры */
  framesDir(label: string): string {
    const time = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
    return path.join(this.dir ?? '', `duostream-${this.day}-${time}-${label}`);
  }

  /** Сжать журналы прошлых дней в .gz, удалить архивы и картинки старше KEEP_DAYS (в фоне) */
  archive(): Promise<void> {
    if (this.archiving) return this.archiving;
    this.archiving = this.archiveNow()
      .catch((err: Error) => this.warn('main', 'архивация журналов:', err.message))
      .finally(() => (this.archiving = null));
    return this.archiving;
  }

  async archiveNow(): Promise<void> {
    const dir = this.dir;
    const today = this.day;
    if (!dir || !today) return;
    const cutoff = localDay(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    const files = await fs.promises.readdir(dir);
    // Недожатый архив (приложение закрыли во время сжатия) — исходники целы, сожмём заново
    for (const f of files) if (f.endsWith('.log.gz.tmp')) await fs.promises.rm(path.join(dir, f), { force: true });
    // Журналы прежнего формата за один день склеиваются в общий архив дня
    const byDay = new Map<string, string[]>();
    for (const f of files) {
      const m = DAY_LOG.exec(f) ?? OLD_LOG.exec(f);
      if (!m || m[1] >= today) continue;
      if (!byDay.has(m[1])) byDay.set(m[1], []);
      byDay.get(m[1])!.push(path.join(dir, f));
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

  /** @param source откуда: main, ui, capture, server… */
  write(level: LogLevel, source: string, ...parts: unknown[]): void {
    const text = parts.map((p) => (typeof p === 'string' ? p : util.inspect(p, { depth: 4, breakLength: 160 }))).join(' ');
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${text}\n`;
    if (this.stream && localDay() !== this.day) this.openDay(); // наступили новые сутки — новый файл
    this.stream?.write(line);
  }

  info(source: string, ...parts: unknown[]): void {
    this.write('info', source, ...parts);
  }

  warn(source: string, ...parts: unknown[]): void {
    this.write('warn', source, ...parts);
  }

  error(source: string, ...parts: unknown[]): void {
    this.write('error', source, ...parts);
  }

  /** console.* главного процесса — ещё и в журнал */
  captureConsole(): void {
    const methods: [keyof Console & ('log' | 'info' | 'warn' | 'error'), LogLevel][] = [
      ['log', 'info'],
      ['info', 'info'],
      ['warn', 'warn'],
      ['error', 'error'],
    ];
    for (const [method, level] of methods) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        original(...args);
        this.write(level, 'main', ...args);
      };
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}

export const log = new Logger();
