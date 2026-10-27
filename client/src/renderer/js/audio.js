// Микрофонный тракт: getUserMedia → AudioWorklet (шумодав DeepFilterNet3 или DTLN на ONNX Runtime)
// → MediaStreamTrack для WebRTC. Трек на выходе постоянный: смена микрофона, модели или вкл/выкл
// шумодава не требуют пересогласования.

export const DENOISE_MODELS = { dfn3: 'DeepFilterNet3', dtln: 'DTLN' };

export class MicPipeline extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.track = null;
    this.muted = false;
    this.denoiseWanted = true;
    /** 'loading' | 'ready' | 'error' */
    this.denoiseEngine = 'loading';
    this.denoiseError = '';
    this.denoiseWarning = ''; // например, DeepFilterNet3 не загрузился и работает DTLN
    this.model = null; // загруженная модель: 'dfn3' | 'dtln'
    this.frame = 0; // размер кадра модели, отсчётов 48 кГц
    this.perf = { avgMs: 0, maxMs: 0, dropped: 0, underruns: 0, gateOpen: 0 };
  }

  /** @param {object} audioCfg раздел audio из stream.config.json */
  async start(audioCfg) {
    this.cfg = audioCfg;
    this.denoiseWanted = audioCfg.noiseSuppression;

    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(new URL('../audio/denoise-worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'duo-denoise', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    this.node.port.onmessage = (event) => {
      if (event.data.type === 'stats') this.perf.underruns = event.data.underruns;
    };
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.levelBuf = new Float32Array(this.analyser.fftSize);
    this.dest = this.ctx.createMediaStreamDestination();
    this.dest.channelCount = 1;
    this.node.connect(this.dest);
    this.node.connect(this.analyser);
    this.track = this.dest.stream.getAudioTracks()[0];

    this.startWorker();
    await this.openMic();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  startWorker() {
    this.worker = new Worker(new URL('../audio/denoise-worker.js', import.meta.url), { type: 'module' });
    const channel = new MessageChannel();
    this.worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'ready') {
        Object.assign(this, { denoiseEngine: 'ready', model: msg.model, frame: msg.frame, vad: msg.vad, denoiseWarning: msg.warning });
        this.applyDenoise();
      } else if (msg.type === 'error') {
        this.denoiseEngine = 'error';
        this.denoiseError = msg.message;
        this.applyDenoise();
      } else if (msg.type === 'stats') {
        Object.assign(this.perf, {
          avgMs: msg.avgMs,
          maxMs: msg.maxMs,
          dropped: this.perf.dropped + msg.dropped,
          gateOpen: msg.gateOpen,
        });
      }
    };
    this.worker.onerror = (event) => {
      this.denoiseEngine = 'error';
      this.denoiseError = event.message || 'не удалось запустить воркер';
      this.applyDenoise();
    };
    const { denoiseModel: model, denoiseLimitDb: limitDb, voiceGate: gate } = this.cfg;
    this.worker.postMessage({ type: 'init', port: channel.port1, model, limitDb, gate }, [channel.port1]);
    this.node.port.postMessage({ type: 'worker-port', port: channel.port2 }, [channel.port2]);
  }

  async openMic() {
    const { micDeviceId, echoCancellation, autoGainControl } = this.cfg;
    const raw = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micDeviceId && micDeviceId !== 'default' ? { exact: micDeviceId } : undefined,
        echoCancellation,
        autoGainControl,
        noiseSuppression: false, // свой шумодав вместо встроенного в WebRTC
        channelCount: 1,
      },
      video: false,
    });
    this.source?.disconnect();
    this.raw?.getTracks().forEach((t) => t.stop());
    this.raw = raw;
    this.source = this.ctx.createMediaStreamSource(raw);
    this.source.connect(this.node);
    this.deviceLabel = raw.getAudioTracks()[0]?.label ?? '';
  }

  /** Применяет новые настройки звука; микрофон переоткрывается, только если это нужно. */
  async reconfigure(audioCfg) {
    const prev = this.cfg;
    this.cfg = audioCfg;
    if (
      prev.micDeviceId !== audioCfg.micDeviceId ||
      prev.echoCancellation !== audioCfg.echoCancellation ||
      prev.autoGainControl !== audioCfg.autoGainControl
    ) {
      await this.openMic();
    }
    if (prev.denoiseLimitDb !== audioCfg.denoiseLimitDb || prev.voiceGate !== audioCfg.voiceGate) {
      this.worker.postMessage({ type: 'options', limitDb: audioCfg.denoiseLimitDb, gate: audioCfg.voiceGate });
    }
    if (prev.denoiseModel !== audioCfg.denoiseModel) {
      // Пока грузится другая модель, голос идёт без шумодава (worklet пропускает звук насквозь)
      this.denoiseEngine = 'loading';
      this.worker.postMessage({ type: 'model', model: audioCfg.denoiseModel });
    }
    this.setDenoise(audioCfg.noiseSuppression);
  }

  setDenoise(on) {
    this.denoiseWanted = on;
    this.applyDenoise();
  }

  applyDenoise() {
    const value = this.denoiseWanted && this.denoiseEngine === 'ready';
    this.node?.port.postMessage({ type: 'enable', value, frame: this.frame });
    this.dispatchEvent(new Event('change'));
  }

  /** 'on' | 'off' | 'loading' | 'error' */
  get denoiseState() {
    if (!this.denoiseWanted) return 'off';
    if (this.denoiseEngine === 'ready') return 'on';
    return this.denoiseEngine;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.track) this.track.enabled = !muted;
    this.dispatchEvent(new Event('change'));
  }

  /** Уровень сигнала после шумодава, 0..1 (для индикатора у кнопки микрофона) */
  level() {
    if (!this.analyser || this.muted) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += v * v;
    const dbfs = 10 * Math.log10(sum / this.levelBuf.length + 1e-12);
    return Math.min(1, Math.max(0, (dbfs + 60) / 60));
  }

  stop() {
    this.raw?.getTracks().forEach((t) => t.stop());
    this.worker?.terminate();
    this.ctx?.close();
    this.track = null;
  }
}
