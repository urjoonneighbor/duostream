// Громкость через Web Audio. Элемент <audio> громче исходника не умеет (volume ≤ 1), поэтому голос
// собеседника и звук трансляции идут через GainNode — до 300% — и лимитер: усиленный звук не хрипит,
// а пики, упирающиеся в 0 дБ, мягко прижимаются.

/** Лимитер: срабатывает только у самого потолка, тихий и средний звук не трогает */
export function createLimiter(ctx: AudioContext): DynamicsCompressorNode {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;
  return limiter;
}

/** Воспроизведение удалённого звука (голос собеседника, звук трансляции) с усилением */
export class Playback {
  readonly element: HTMLAudioElement;
  readonly ctx: AudioContext;
  readonly gain: GainNode;
  private source: MediaStreamAudioSourceNode | null = null;
  private volume = 1;
  private muted = false;

  /**
   * @param latencyHint 'playback' — для звука трансляции: буферы больше, и под нагрузкой (декодирование 60 FPS)
   * поток отрисовки звука не опустошает их — без треска; задержка в несколько десятков мс для фильма неважна.
   * Голосу нужна малая задержка — 'interactive'
   */
  constructor(element: HTMLAudioElement, latencyHint: AudioContextLatencyCategory = 'interactive') {
    // Chromium не отдаёт звук удалённого WebRTC-трека в Web Audio, пока трек не подключён к медиаэлементу,
    // поэтому элемент остаётся (без звука), а слышно то, что идёт через граф
    this.element = element;
    this.element.muted = true;
    this.ctx = new AudioContext({ latencyHint });
    this.gain = this.ctx.createGain();
    this.gain.connect(createLimiter(this.ctx)).connect(this.ctx.destination);
  }

  attach(stream: MediaStream): void {
    this.detach();
    this.element.srcObject = stream;
    this.element.play().catch(() => {});
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.gain);
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  detach(): void {
    this.source?.disconnect();
    this.source = null;
    this.element.srcObject = null;
  }

  /** @param volume 1 = 100% */
  setVolume(volume: number): void {
    this.volume = volume;
    this.apply();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.apply();
  }

  private apply(): void {
    this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
  }

  /** @param deviceId 'default' — устройство вывода по умолчанию */
  setSink(deviceId: string): Promise<void> {
    return this.ctx.setSinkId(deviceId && deviceId !== 'default' ? deviceId : '');
  }
}

/**
 * Стример: громкость звука трансляции (игра, окно, система), который уходит зрителю. Исходный трек
 * проходит через GainNode и лимитер; наружу — новый стерео-трек.
 */
export class SendGain {
  private readonly input: MediaStreamTrack;
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  readonly track: MediaStreamTrack;

  constructor(track: MediaStreamTrack) {
    this.input = track;
    // Буферы побольше: под нагрузкой (захват 60 FPS, кодировщик, шумодав) с малыми буферами поток Web Audio
    // не успевал, и в звук трансляции попадали дыры — треск у зрителя
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
    this.gain = this.ctx.createGain();
    const dest = this.ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    this.ctx.createMediaStreamSource(new MediaStream([track])).connect(this.gain);
    this.gain.connect(createLimiter(this.ctx)).connect(dest);
    this.track = dest.stream.getAudioTracks()[0];
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /** @param volume 1 = 100% */
  setVolume(volume: number): void {
    this.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
  }

  /**
   * Сколько звука потеряно с начала трансляции, мс: на захвате (Windows/Chromium не отдали вовремя) и после
   * регулятора громкости (Web Audio не успел). Где растёт — там и треск у зрителя
   */
  lostMs(): { capture: number; mixer: number } | null {
    type TrackStats = { totalFramesDuration: number; deliveredFramesDuration: number };
    const lost = (t: MediaStreamTrack) => {
      const st = (t as MediaStreamTrack & { stats?: TrackStats }).stats;
      return st ? Math.max(0, st.totalFramesDuration - st.deliveredFramesDuration) : null;
    };
    const capture = lost(this.input);
    const mixer = lost(this.track);
    return capture === null || mixer === null ? null : { capture: Math.round(capture), mixer: Math.round(mixer) };
  }

  stop(): void {
    this.input.stop();
    this.track.stop();
    this.ctx.close().catch(() => {});
  }
}
