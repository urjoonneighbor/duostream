// Звук реакций: общий AudioContext с голосом собеседника (js/playback.ts) — отдельный поток вывода на слабых ПК
// не нужен, и устройство вывода меняется вместе с голосом. Узлы свои: регулятор громкости и лимитер.
//
// Два пути воспроизведения. Свои файлы (выбраны в диалоге, лежат на диске) раскодируются один раз и хранятся в кэше.
// Файлы собеседника — только потоком через <audio> и MediaElementSource: decodeAudioData разворачивает файл целиком,
// сколько бы кадров в нём ни было, и 2 МБ FLAC с поддельным заголовком дают десятки ГБ PCM. Заголовку верить нельзя,
// а потоковый декодер держит в памяти только небольшой запас и останавливается через MAX_SECONDS.
//
// В трансляцию этот звук не попадает тем же путём, что и голос зрителя: при системном loopback с restrictOwnAudio
// Chromium берёт устройство без звука самого приложения, а захват звука окна (duostream-capture.exe --audio-window)
// видит только процесс транслируемого окна и его дочерние, не DuoStream.
import { createLimiter } from './playback.ts';

const MAX_SECONDS = 5; // звук жёстко не длиннее
const FADE_SECONDS = 0.03; // обрезанный конец — без щелчка
const MAX_VOICES = 3;
const MAX_VIDEO_STREAMS = 1; // звук из видео собеседника идёт через <audio>: скрытых видео-декодеров не больше одного
const REMOTE_INTERVAL_MS = 300; // от собеседника не чаще
const STREAM_START_TIMEOUT_MS = 3000; // файл собеседника не начал играть — считаем беззвучным
// Свой файл: длинная запись не должна разворачиваться целиком; разумный файл с запасом короче этого предела, а звук всё равно обрежется до MAX_SECONDS
const MAX_DECODE_SECONDS = 120;
const UNKNOWN_DURATION_MAX_BYTES = 1024 * 1024; // длительность неизвестна (WebM без заголовка) — только маленький файл
const PROBE_TIMEOUT_MS = 5000;
const CACHE_ITEMS = 64;
const CACHE_BYTES = 48 * 1024 * 1024;

/** Играющий звук: preview («Прослушать») не зависит от настройки «Звук реакций» */
interface Voice {
  preview: boolean;
  /** Поток из файла-видео */
  video: boolean;
  stop: () => void;
}

/** Длительность по заголовку файла: Infinity — заголовок её не сообщает, null — файл не читается */
function probeSeconds(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const src = URL.createObjectURL(blob);
    const audio = new Audio();
    let finished = false;
    const finish = (seconds: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load(); // отпускает декодер
      URL.revokeObjectURL(src);
      resolve(seconds);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    audio.preload = 'metadata';
    audio.addEventListener('error', () => finish(null), { once: true });
    audio.addEventListener('loadedmetadata', () => finish(Number.isFinite(audio.duration) ? audio.duration : Infinity), { once: true });
    audio.src = src;
  });
}

export class ReactionSound {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly voices = new Set<Voice>();
  /** hash → раскодированный звук (null — беззвучно); самые давние вытесняются */
  private readonly decoded = new Map<string, Promise<AudioBuffer | null>>();
  private readonly sizes = new Map<string, number>();
  private cachedBytes = 0;
  /** Декодирование тяжёлое — строго по одному */
  private decodeChain: Promise<unknown> = Promise.resolve();
  private on = true;
  private volume = 1;
  private deafened = false;
  private lastRemoteAt = -Infinity;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(createLimiter(ctx)).connect(ctx.destination);
  }

  get enabled(): boolean {
    return this.on && !this.deafened;
  }

  /** @param volume усиление (1 = 100%) */
  configure(on: boolean, volume: number): void {
    this.on = on;
    this.volume = volume;
    this.applyGain();
    if (!on) for (const voice of [...this.voices]) if (!voice.preview) voice.stop(); // настройка действует сразу, в том числе на уже звучащее
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    if (deafened) for (const voice of [...this.voices]) voice.stop(); // не доигрывает молча и не вернётся при включении звука
    this.applyGain();
  }

  private applyGain(): void {
    this.master.gain.setTargetAtTime(this.deafened ? 0 : this.volume, this.ctx.currentTime, 0.02);
  }

  /** Есть ли в своём файле звуковая дорожка, которую можно воспроизвести */
  async hasAudio(id: string, blob: Blob): Promise<boolean> {
    return (await this.decode(id, blob)) !== null;
  }

  /** Звук уже раскодирован: файл для воспроизведения не нужен */
  isDecoded(id: string): boolean {
    return this.decoded.has(id);
  }

  /**
   * @param id ключ кэша (hash файла, из которого берётся звук)
   * @param blob файл; null — только если isDecoded
   * @param remote от собеседника: не чаще раза в 300 мс
   * @param preview кнопка «Прослушать»: играет и при выключенной настройке, но не при выключенном звуке
   * @param untrusted файл прислал собеседник: только потоком, в decodeAudioData он не попадает
   */
  async play(id: string, blob: Blob | null, { remote = false, preview = false, untrusted = false } = {}): Promise<void> {
    const allowed = () => (preview ? !this.deafened : this.enabled);
    if (!allowed() || this.voices.size >= MAX_VOICES) return;
    if (remote) {
      const now = performance.now();
      if (now - this.lastRemoteAt < REMOTE_INTERVAL_MS) return;
      this.lastRemoteAt = now;
    }
    if (untrusted && blob && !this.decoded.has(id)) {
      this.playStream(blob, preview);
      return;
    }
    const buffer = await this.decode(id, blob);
    if (!buffer || !allowed() || this.voices.size >= MAX_VOICES) return;
    this.playBuffer(buffer, preview);
  }

  private resume(): void {
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  private playBuffer(buffer: AudioBuffer, preview: boolean): void {
    this.resume();
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master);
    const voice: Voice = { preview, video: false, stop: () => source.stop() };
    this.voices.add(voice);
    source.onended = () => {
      this.voices.delete(voice);
      source.disconnect();
    };
    source.start(0, 0, MAX_SECONDS);
  }

  /** Файл собеседника: декодер работает по ходу воспроизведения, поэтому память не зависит от содержимого файла */
  private playStream(blob: Blob, preview: boolean): void {
    const video = blob.type.startsWith('video/');
    if (video && [...this.voices].filter((v) => v.video).length >= MAX_VIDEO_STREAMS) return;
    this.resume();
    const url = URL.createObjectURL(blob);
    const element = new Audio();
    element.preload = 'auto';
    const source = this.ctx.createMediaElementSource(element);
    const fade = this.ctx.createGain();
    source.connect(fade).connect(this.master);
    let timer = setTimeout(() => voice.stop(), STREAM_START_TIMEOUT_MS);
    const voice: Voice = {
      preview,
      video,
      stop: () => {
        if (!this.voices.delete(voice)) return;
        clearTimeout(timer);
        element.pause();
        element.removeAttribute('src');
        element.load(); // отпускает декодер
        source.disconnect();
        fade.disconnect();
        URL.revokeObjectURL(url);
      },
    };
    this.voices.add(voice);
    element.addEventListener(
      'playing',
      () => {
        if (!this.voices.has(voice)) return;
        clearTimeout(timer);
        const end = this.ctx.currentTime + MAX_SECONDS;
        fade.gain.setValueAtTime(1, end - FADE_SECONDS);
        fade.gain.linearRampToValueAtTime(0, end);
        timer = setTimeout(() => voice.stop(), MAX_SECONDS * 1000);
      },
      { once: true },
    );
    element.addEventListener('ended', () => voice.stop(), { once: true });
    element.addEventListener('error', () => voice.stop(), { once: true });
    element.src = url;
    element.play().catch(() => voice.stop());
  }

  private decode(id: string, blob: Blob | null): Promise<AudioBuffer | null> {
    const known = this.decoded.get(id);
    if (known) {
      this.decoded.delete(id);
      this.decoded.set(id, known); // самый свежий — в конец
      return known;
    }
    if (!blob) return Promise.resolve(null);
    const job = this.decodeChain.then(() => this.decodeFile(blob));
    this.decodeChain = job;
    this.decoded.set(id, job);
    void job.then((buffer) => this.remember(id, job, buffer));
    return job;
  }

  /** Только свои файлы. Любая ошибка декодирования — беззвучная реакция */
  private async decodeFile(blob: Blob): Promise<AudioBuffer | null> {
    try {
      const seconds = await probeSeconds(blob);
      if (seconds === null || (Number.isFinite(seconds) && seconds > MAX_DECODE_SECONDS)) return null;
      if (seconds === Infinity && blob.size > UNKNOWN_DURATION_MAX_BYTES) return null;
      return this.trim(await this.ctx.decodeAudioData(await blob.arrayBuffer()));
    } catch {
      return null;
    }
  }

  /** Первые MAX_SECONDS, не больше двух каналов: в кэше не лежит лишнее */
  private trim(buffer: AudioBuffer): AudioBuffer {
    const maxFrames = Math.floor(MAX_SECONDS * buffer.sampleRate);
    const channels = Math.min(2, buffer.numberOfChannels);
    if (buffer.length <= maxFrames && channels === buffer.numberOfChannels) return buffer;
    const frames = Math.min(buffer.length, maxFrames);
    const out = this.ctx.createBuffer(channels, frames, buffer.sampleRate);
    const fade = Math.min(frames, Math.floor(FADE_SECONDS * buffer.sampleRate));
    for (let ch = 0; ch < channels; ch++) {
      const data = out.getChannelData(ch);
      buffer.copyFromChannel(data, ch);
      if (buffer.length > maxFrames) for (let i = 0; i < fade; i++) data[frames - 1 - i] *= i / fade;
    }
    return out;
  }

  private remember(id: string, job: Promise<AudioBuffer | null>, buffer: AudioBuffer | null): void {
    if (this.decoded.get(id) !== job) return; // вытеснен, пока декодировался: считать нечего
    const bytes = buffer ? buffer.length * buffer.numberOfChannels * 4 : 0;
    this.sizes.set(id, bytes);
    this.cachedBytes += bytes;
    for (const old of this.decoded.keys()) {
      if (this.decoded.size <= CACHE_ITEMS && this.cachedBytes <= CACHE_BYTES) break;
      if (old === id) continue;
      this.decoded.delete(old);
      this.cachedBytes -= this.sizes.get(old) ?? 0;
      this.sizes.delete(old);
    }
  }
}
