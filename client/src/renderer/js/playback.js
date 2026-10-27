// Громкость через Web Audio. Элемент <audio> громче исходника не умеет (volume ≤ 1), поэтому голос
// собеседника и звук трансляции идут через GainNode — до 300% — и лимитер: усиленный звук не хрипит,
// а пики, упирающиеся в 0 дБ, мягко прижимаются.

/** Лимитер: срабатывает только у самого потолка, тихий и средний звук не трогает */
function createLimiter(ctx) {
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
  /** @param {HTMLAudioElement} element */
  constructor(element) {
    // Chromium не отдаёт звук удалённого WebRTC-трека в Web Audio, пока трек не подключён к медиаэлементу,
    // поэтому элемент остаётся (без звука), а слышно то, что идёт через граф
    this.element = element;
    this.element.muted = true;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.connect(createLimiter(this.ctx)).connect(this.ctx.destination);
    this.source = null;
    this.volume = 1;
    this.muted = false;
  }

  attach(stream) {
    this.detach();
    this.element.srcObject = stream;
    this.element.play().catch(() => {});
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.gain);
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  detach() {
    this.source?.disconnect();
    this.source = null;
    this.element.srcObject = null;
  }

  /** @param {number} volume 1 = 100% */
  setVolume(volume) {
    this.volume = volume;
    this.apply();
  }

  setMuted(muted) {
    this.muted = muted;
    this.apply();
  }

  apply() {
    this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
  }

  /** @param {string} deviceId 'default' — устройство вывода по умолчанию */
  setSink(deviceId) {
    return this.ctx.setSinkId(deviceId && deviceId !== 'default' ? deviceId : '');
  }
}

/**
 * Стример: громкость звука трансляции (игра, окно, система), который уходит зрителю. Исходный трек
 * проходит через GainNode и лимитер; наружу — новый стерео-трек.
 */
export class SendGain {
  /** @param {MediaStreamTrack} track */
  constructor(track) {
    this.input = track;
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    const dest = this.ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    this.ctx.createMediaStreamSource(new MediaStream([track])).connect(this.gain);
    this.gain.connect(createLimiter(this.ctx)).connect(dest);
    this.track = dest.stream.getAudioTracks()[0];
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /** @param {number} volume 1 = 100% */
  setVolume(volume) {
    this.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
  }

  stop() {
    this.input.stop();
    this.track.stop();
    this.ctx.close().catch(() => {});
  }
}
