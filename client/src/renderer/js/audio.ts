// Микрофонный тракт: getUserMedia → AudioWorklet (шумодав DeepFilterNet3 или DTLN на ONNX Runtime)
// → MediaStreamTrack для WebRTC. Трек на выходе постоянный: смена микрофона, модели или вкл/выкл
// шумодава не требуют пересогласования.
import type { Config, DenoiseModel } from '../../shared/config';
import type { WorkerMessage } from '../audio/messages';

type AudioConfig = Config['audio'];
export type DenoiseState = 'on' | 'off' | 'loading' | 'error';

export const DENOISE_MODELS: Record<DenoiseModel, string> = { dfn3: 'DeepFilterNet3', dtln: 'DTLN' };

export class MicPipeline extends EventTarget {
  ctx: AudioContext | null = null;
  track: MediaStreamTrack | null = null;
  muted = false;
  denoiseWanted = true;
  denoiseEngine: 'loading' | 'ready' | 'error' = 'loading';
  denoiseError = '';
  denoiseWarning = ''; // например, DeepFilterNet3 не загрузился и работает DTLN
  model: DenoiseModel | null = null; // загруженная модель
  frame = 0; // размер кадра модели, отсчётов 48 кГц
  /** Голосовой порог по Silero VAD (а не по оценке SNR модели) */
  vad = false;
  deviceLabel = '';
  perf = { avgMs: 0, maxMs: 0, dropped: 0, underruns: 0, gateOpen: 0 };
  private cfg!: AudioConfig;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf = new Float32Array(0);
  private dest: MediaStreamAudioDestinationNode | null = null;
  private worker: Worker | null = null;
  private raw: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  /** @param audioCfg раздел audio из stream.config.json */
  async start(audioCfg: AudioConfig): Promise<void> {
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

  private startWorker(): void {
    const worker = new Worker(new URL('../audio/denoise-worker.js', import.meta.url), { type: 'module' });
    this.worker = worker;
    const channel = new MessageChannel();
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
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
    worker.onerror = (event) => {
      this.denoiseEngine = 'error';
      this.denoiseError = event.message || 'не удалось запустить воркер';
      this.applyDenoise();
    };
    const { denoiseModel: model, denoiseLimitDb: limitDb, voiceGate: gate } = this.cfg;
    worker.postMessage({ type: 'init', port: channel.port1, model, limitDb, gate }, [channel.port1]);
    this.node!.port.postMessage({ type: 'worker-port', port: channel.port2 }, [channel.port2]);
  }

  private async openMic(): Promise<void> {
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
    this.source = this.ctx!.createMediaStreamSource(raw);
    this.source.connect(this.node!);
    this.deviceLabel = raw.getAudioTracks()[0]?.label ?? '';
  }

  /** Применяет новые настройки звука; микрофон переоткрывается, только если это нужно. */
  async reconfigure(audioCfg: AudioConfig): Promise<void> {
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
      this.worker?.postMessage({ type: 'options', limitDb: audioCfg.denoiseLimitDb, gate: audioCfg.voiceGate });
    }
    if (prev.denoiseModel !== audioCfg.denoiseModel) {
      // Пока грузится другая модель, голос идёт без шумодава (worklet пропускает звук насквозь)
      this.denoiseEngine = 'loading';
      this.worker?.postMessage({ type: 'model', model: audioCfg.denoiseModel });
    }
    this.setDenoise(audioCfg.noiseSuppression);
  }

  setDenoise(on: boolean): void {
    this.denoiseWanted = on;
    this.applyDenoise();
  }

  private applyDenoise(): void {
    const value = this.denoiseWanted && this.denoiseEngine === 'ready';
    this.node?.port.postMessage({ type: 'enable', value, frame: this.frame });
    this.dispatchEvent(new Event('change'));
  }

  get denoiseState(): DenoiseState {
    if (!this.denoiseWanted) return 'off';
    if (this.denoiseEngine === 'ready') return 'on';
    return this.denoiseEngine;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.track) this.track.enabled = !muted;
    this.dispatchEvent(new Event('change'));
  }

  /** Уровень сигнала после шумодава, 0..1 (для индикатора у кнопки микрофона) */
  level(): number {
    if (!this.analyser || this.muted) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += v * v;
    const dbfs = 10 * Math.log10(sum / this.levelBuf.length + 1e-12);
    return Math.min(1, Math.max(0, (dbfs + 60) / 60));
  }

  stop(): void {
    this.raw?.getTracks().forEach((t) => t.stop());
    this.worker?.terminate();
    void this.ctx?.close();
    this.track = null;
  }
}
