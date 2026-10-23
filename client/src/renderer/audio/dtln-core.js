/**
 * Ядро шумоподавления: DTLN (Dual-signal Transformation LSTM Network, N. Westhausen, MIT)
 * на ONNX Runtime. Модуль не зависит от браузера — его используют и Web Worker,
 * и оффлайн-тест в Node (scripts/test-denoiser.mjs).
 *
 * Модель работает на 16 кГц блоками по 512 отсчётов с шагом 128 (8 мс):
 *   model_1: |rFFT(блок)| [1,1,257] + состояние LSTM [1,2,128,2] → маска [1,1,257]
 *   model_2: iFFT(спектр·маска) [1,1,512] + состояние → блок [1,1,512] → overlap-add
 * Звук WebRTC идёт на 48 кГц, поэтому вокруг модели стоят полифазные ресемплеры ×3.
 */

export const SAMPLE_RATE = 48000;
export const MODEL_RATE = 16000;
export const BLOCK_LEN = 512;
export const BLOCK_SHIFT = 128;
/** Кадр на 48 кГц, соответствующий одному шагу модели (8 мс) */
export const FRAME_48K = BLOCK_SHIFT * 3;

const BINS = BLOCK_LEN / 2 + 1;
const STATE_SHAPE = [1, 2, 128, 2];
const STATE_SIZE = 2 * 128 * 2;

/** Комплексное БПФ по основанию 2 (на месте). */
export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** inverse=false: X[k] = Σ x[t]·e^{-2πikt/n}; inverse=true: x = (1/n)·Σ X[k]·e^{+2πikt/n} */
  transform(re, im, inverse = false) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = start + j;
          const b = a + half;
          const wr = cos[k];
          const wi = sign * sin[k];
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }
}

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** ФНЧ (windowed-sinc с окном Кайзера), нормированный на единичное усиление в полосе пропускания. */
export function designLowpass(taps, cutoffHz, sampleRate, beta = 8) {
  const h = new Float64Array(taps);
  const fc = cutoffHz / sampleRate;
  const mid = (taps - 1) / 2;
  const denom = besselI0(beta);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const r = (2 * i) / (taps - 1) - 1;
    h[i] = sinc * (besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom);
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

// 243 отвода (кратно 3), срез 7.4 кГц, подавление > 70 дБ выше 8 кГц
const RESAMPLER_TAPS = 243;
const RESAMPLER_FIR = designLowpass(RESAMPLER_TAPS, 7400, SAMPLE_RATE, 8);

/** Потоковое понижение частоты 48 → 16 кГц. */
export class Decimator3 {
  constructor(h = RESAMPLER_FIR) {
    this.h = h;
    this.hist = new Float64Array(h.length - 1);
    this.work = new Float64Array(0);
  }

  /** @param {Float32Array} input длина кратна 3 */
  process(input, output = new Float32Array(input.length / 3)) {
    const { h, hist } = this;
    const N = h.length;
    const total = hist.length + input.length;
    if (this.work.length !== total) this.work = new Float64Array(total);
    const w = this.work;
    w.set(hist, 0);
    for (let i = 0; i < input.length; i++) w[hist.length + i] = input[i];
    for (let k = 0; k < output.length; k++) {
      const end = N - 1 + 3 * k;
      let acc = 0;
      for (let i = 0; i < N; i++) acc += h[i] * w[end - i];
      output[k] = acc;
    }
    hist.set(w.subarray(total - hist.length));
    return output;
  }
}

/** Потоковое повышение частоты 16 → 48 кГц (полифазная реализация). */
export class Interpolator3 {
  constructor(h = RESAMPLER_FIR) {
    const L = h.length / 3;
    if (!Number.isInteger(L)) throw new Error('FIR length must be a multiple of 3');
    // Фазы фильтра: phases[p][j] = 3·h[3j + p] (×3 компенсирует вставку нулей)
    this.phases = [0, 1, 2].map((p) => Float64Array.from({ length: L }, (_, j) => 3 * h[3 * j + p]));
    this.L = L;
    this.hist = new Float64Array(L - 1);
    this.work = new Float64Array(0);
  }

  process(input, output = new Float32Array(input.length * 3)) {
    const { L, hist, phases } = this;
    const total = hist.length + input.length;
    if (this.work.length !== total) this.work = new Float64Array(total);
    const w = this.work;
    w.set(hist, 0);
    for (let i = 0; i < input.length; i++) w[hist.length + i] = input[i];
    for (let n = 0; n < input.length; n++) {
      const end = L - 1 + n;
      for (let p = 0; p < 3; p++) {
        const ph = phases[p];
        let acc = 0;
        for (let j = 0; j < L; j++) acc += ph[j] * w[end - j];
        output[3 * n + p] = acc;
      }
    }
    hist.set(w.subarray(total - hist.length));
    return output;
  }
}

/** Двухступенчатая модель DTLN на 16 кГц с сохранением состояния LSTM между блоками. */
export class DtlnEngine {
  /**
   * @param ort пространство имён onnxruntime-web
   * @param {Uint8Array|ArrayBuffer} model1
   * @param {Uint8Array|ArrayBuffer} model2
   */
  static async create(ort, model1, model2) {
    const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const s1 = await ort.InferenceSession.create(new Uint8Array(model1), options);
    const s2 = await ort.InferenceSession.create(new Uint8Array(model2), options);
    return new DtlnEngine(ort, s1, s2);
  }

  constructor(ort, session1, session2) {
    this.ort = ort;
    this.s1 = session1;
    this.s2 = session2;
    this.fft = new FFT(BLOCK_LEN);
    this.re = new Float64Array(BLOCK_LEN);
    this.im = new Float64Array(BLOCK_LEN);
    this.mag = new Float32Array(BINS);
    this.block = new Float32Array(BLOCK_LEN);
    this.reset();
  }

  reset() {
    const { Tensor } = this.ort;
    this.inBuf = new Float32Array(BLOCK_LEN);
    this.outBuf = new Float32Array(BLOCK_LEN);
    this.state1 = new Tensor('float32', new Float32Array(STATE_SIZE), STATE_SHAPE);
    this.state2 = new Tensor('float32', new Float32Array(STATE_SIZE), STATE_SHAPE);
  }

  /**
   * Обрабатывает 128 новых отсчётов (16 кГц) и возвращает 128 очищенных.
   * @param {Float32Array} input
   * @param {Float32Array} [output]
   */
  async process(input, output = new Float32Array(BLOCK_SHIFT)) {
    const { Tensor } = this.ort;
    const { inBuf, outBuf, re, im, mag, fft, block } = this;

    inBuf.copyWithin(0, BLOCK_SHIFT);
    inBuf.set(input, BLOCK_LEN - BLOCK_SHIFT);

    for (let i = 0; i < BLOCK_LEN; i++) {
      re[i] = inBuf[i];
      im[i] = 0;
    }
    fft.transform(re, im, false);
    for (let k = 0; k < BINS; k++) mag[k] = Math.hypot(re[k], im[k]);

    const r1 = await this.s1.run({
      [this.s1.inputNames[0]]: new Tensor('float32', mag, [1, 1, BINS]),
      [this.s1.inputNames[1]]: this.state1,
    });
    const mask = r1[this.s1.outputNames[0]].data;
    this.state1 = r1[this.s1.outputNames[1]];

    // Маска вещественная: умножаем бины k и n−k, сохраняя эрмитову симметрию спектра
    re[0] *= mask[0];
    im[0] *= mask[0];
    for (let k = 1; k < BINS - 1; k++) {
      const m = mask[k];
      re[k] *= m;
      im[k] *= m;
      re[BLOCK_LEN - k] *= m;
      im[BLOCK_LEN - k] *= m;
    }
    re[BINS - 1] *= mask[BINS - 1];
    im[BINS - 1] *= mask[BINS - 1];
    fft.transform(re, im, true);
    for (let i = 0; i < BLOCK_LEN; i++) block[i] = re[i];

    const r2 = await this.s2.run({
      [this.s2.inputNames[0]]: new Tensor('float32', block, [1, 1, BLOCK_LEN]),
      [this.s2.inputNames[1]]: this.state2,
    });
    const estimated = r2[this.s2.outputNames[0]].data;
    this.state2 = r2[this.s2.outputNames[1]];

    outBuf.copyWithin(0, BLOCK_SHIFT);
    outBuf.fill(0, BLOCK_LEN - BLOCK_SHIFT);
    for (let i = 0; i < BLOCK_LEN; i++) outBuf[i] += estimated[i];
    output.set(outBuf.subarray(0, BLOCK_SHIFT));
    return output;
  }
}

/** Полный тракт на 48 кГц: 384 отсчёта → 16 кГц → DTLN → 48 кГц → 384 отсчёта. */
export class Denoiser48k {
  constructor(engine) {
    this.engine = engine;
    this.decimator = new Decimator3();
    this.interpolator = new Interpolator3();
    this.low = new Float32Array(BLOCK_SHIFT);
    this.clean = new Float32Array(BLOCK_SHIFT);
  }

  reset() {
    this.engine.reset();
    this.decimator = new Decimator3();
    this.interpolator = new Interpolator3();
  }

  /** @param {Float32Array} frame ровно FRAME_48K отсчётов */
  async process(frame, output = new Float32Array(FRAME_48K)) {
    if (frame.length !== FRAME_48K) throw new Error(`expected ${FRAME_48K} samples, got ${frame.length}`);
    this.decimator.process(frame, this.low);
    await this.engine.process(this.low, this.clean);
    return this.interpolator.process(this.clean, output);
  }
}
