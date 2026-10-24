// DeepFilterNet3 (MIT/Apache-2.0, github.com/Rikorose/DeepFilterNet) — полнодиапазонный шумодав 48 кГц.
// Потоковый ONNX-экспорт (github.com/grazder/DeepFilterNet, torchDF): один граф на шаг 10 мс,
// STFT, ERB-признаки и deep filtering внутри графа, рекуррентные состояния — явным тензором.
// Работает и в Web Worker приложения, и в Node (scripts/test-denoiser.mjs).

export const DFN_FRAME = 480; // 10 мс @ 48 кГц — шаг STFT модели
const STATE_SIZE = 45304;

export class DfnDenoiser {
  /**
   * @param {typeof import('onnxruntime-web')} ort
   * @param {ArrayBuffer|Uint8Array} model denoiser_model.onnx
   */
  static async create(ort, model) {
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return new DfnDenoiser(ort, session);
  }

  constructor(ort, session) {
    this.ort = ort;
    this.session = session;
    this.input = new Float32Array(DFN_FRAME);
    this.limit = new Float32Array(1);
    /** Оценка SNR последнего кадра, дБ (выход модели lsnr) */
    this.lsnr = 0;
    this.reset();
  }

  reset() {
    this.states = new this.ort.Tensor('float32', new Float32Array(STATE_SIZE), [STATE_SIZE]);
  }

  /**
   * Предел подавления: шум ослабляется не больше чем на db дБ (остаток звучит естественнее).
   * 0 — без предела, максимальное подавление.
   */
  setAttenuationLimit(db) {
    this.limit[0] = Math.max(0, db);
  }

  /** @param {Float32Array} frame ровно DFN_FRAME отсчётов 48 кГц; возвращает кадр с задержкой 30 мс */
  async process(frame, output = new Float32Array(DFN_FRAME)) {
    if (frame.length !== DFN_FRAME) throw new Error(`expected ${DFN_FRAME} samples, got ${frame.length}`);
    const { Tensor } = this.ort;
    this.input.set(frame);
    const result = await this.session.run({
      input_frame: new Tensor('float32', this.input, [DFN_FRAME]),
      states: this.states,
      atten_lim_db: new Tensor('float32', this.limit, []),
    });
    const enhanced = result.enhanced_audio_frame.data;
    // Рекуррентная сеть может «разойтись» на патологическом входе — тогда начинаем с чистого состояния
    if (!Number.isFinite(enhanced[0]) || !Number.isFinite(enhanced[DFN_FRAME - 1])) {
      this.reset();
      output.set(frame);
      return output;
    }
    this.states = result.new_states;
    this.lsnr = result.lsnr.data[0];
    output.set(enhanced);
    return output;
  }
}

/**
 * Голосовой порог (как автоматическая чувствительность микрофона в Discord): между фразами
 * глушит остаток шума полностью. Решение «говорит / молчит» — по оценке SNR самой модели (lsnr),
 * а не по громкости, поэтому тихий голос не обрезается, а громкий вентилятор не открывает порог.
 * lsnr опережает очищенный звук примерно на кадр, так что начало слова не теряется.
 */
export class VoiceGate {
  constructor({ openDb = -5, holdMs = 300, attackMs = 5, releaseMs = 120, frame = DFN_FRAME, sampleRate = 48000 } = {}) {
    this.openDb = openDb;
    this.holdFrames = Math.round((holdMs / 1000) * (sampleRate / frame));
    this.attackStep = 1 / ((attackMs / 1000) * sampleRate);
    this.releaseStep = 1 / ((releaseMs / 1000) * sampleRate);
    this.reset();
  }

  reset() {
    this.gain = 0;
    this.holdLeft = 0;
  }

  get open() {
    return this.holdLeft > 0;
  }

  /** Применяет порог к кадру на месте. */
  process(samples, lsnr) {
    if (lsnr >= this.openDb) this.holdLeft = this.holdFrames;
    else if (this.holdLeft > 0) this.holdLeft--;
    const target = this.holdLeft > 0 ? 1 : 0;
    for (let i = 0; i < samples.length; i++) {
      if (this.gain < target) this.gain = Math.min(target, this.gain + this.attackStep);
      else if (this.gain > target) this.gain = Math.max(target, this.gain - this.releaseStep);
      samples[i] *= this.gain;
    }
    return samples;
  }
}
