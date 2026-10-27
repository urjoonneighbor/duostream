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
 * глушит микрофон полностью. Решение «говорит / молчит» принимает не громкость, а распознаватель речи
 * (Silero VAD, vad-core.js) или, если его нет, оценка SNR самой DeepFilterNet3 (lsnr). Поэтому тихий
 * голос не обрезается, а громкий вентилятор, скрип или шмыганье порог не открывают.
 * Решение считается по входу, а очищенный звук отстаёт на 30 мс — начало слова не теряется.
 *
 * Silero изредка на мгновение принимает за речь шумные всплески (смыв унитаза, плеск, бульканье),
 * и порог открывался на 250 мс. DeepFilterNet3 такие звуки при этом считает шумом и убирает почти
 * целиком (−50…−60 дБ), а от речи даже на громком фоне оставляет большую часть (обычно −1…−7 дБ).
 * Поэтому порог открывается, только если модель оставила хотя бы OPEN_KEEP_DB; уже открытый порог
 * держится по одному Silero, чтобы речь на шумном фоне не рвалась.
 */
const OPEN_KEEP_DB = -20;

export class VoiceGate {
  constructor({ holdMs = 250, attackMs = 5, releaseMs = 80, frame = DFN_FRAME, sampleRate = 48000 } = {}) {
    this.holdFrames = Math.round((holdMs / 1000) * (sampleRate / frame));
    this.attackStep = 1 / ((attackMs / 1000) * sampleRate);
    this.releaseStep = 1 / ((releaseMs / 1000) * sampleRate);
    this.reset();
  }

  reset() {
    this.gain = 0;
    this.holdLeft = 0;
    this.energyIn = 0;
    this.energyOut = 0;
  }

  get open() {
    return this.holdLeft > 0;
  }

  /** Сколько энергии оставил шумодав, дБ (сглажено ~50 мс) */
  get keepDb() {
    return 10 * Math.log10((this.energyOut + 1e-12) / (this.energyIn + 1e-12));
  }

  /** Учитывает кадр до и после шумодава — до process() */
  observe(input, output) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < input.length; i++) a += input[i] * input[i];
    for (let i = 0; i < output.length; i++) b += output[i] * output[i];
    this.energyIn = 0.8 * this.energyIn + 0.2 * a;
    this.energyOut = 0.8 * this.energyOut + 0.2 * b;
  }

  /** Речь по Silero: открыть с 0,5 (если шумодав не счёл звук шумом), держать открытым, пока не ниже 0,35 */
  speechByVad(prob) {
    if (this.open) return prob >= 0.35;
    return prob >= 0.5 && this.keepDb >= OPEN_KEEP_DB;
  }

  /** Речь по оценке SNR DeepFilterNet3 (если Silero не загрузился) */
  speechByLsnr(lsnr) {
    return lsnr >= -5;
  }

  /** Применяет порог к кадру на месте. speech — в этом кадре речь. */
  process(samples, speech) {
    if (speech) this.holdLeft = this.holdFrames;
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
