// Оффлайн-проверка шумодава тем же кодом, что работает в приложении
// (src/renderer/audio/dfn-core.js и dtln-core.js).
//
//   node scripts/test-denoiser.mjs [речь.wav] [SNR дБ] [--model=dfn3|dtln] [--limit=дБ] [--noise=fan|keys|human|flush] [--gate]
//
// Без файла используется синтетический «голос» (DeepFilterNet3 справедливо считает его гудком и глушит —
// для оценки передайте запись речи). --limit — предел подавления DeepFilterNet3 (0 — без предела),
// --noise — фон вентилятора с гулом 50 Гц, щелчки клавиатуры, human — шмыганье и скрип кресла,
// flush — смыв унитаза (поток воды с бульканьем).
// --gate — голосовой порог по Silero VAD.
// Результат пишется в test-output/: noisy.wav (вход), denoised.wav (выход) — их можно прослушать.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';
import {
  Decimator3,
  Interpolator3,
  DtlnEngine,
  Denoiser48k,
  FRAME_48K,
  SAMPLE_RATE,
} from '../src/renderer/audio/dtln-core.js';
import { DfnDenoiser, DFN_FRAME, VoiceGate } from '../src/renderer/audio/dfn-core.js';
import { SileroVad } from '../src/renderer/audio/vad-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = path.join(root, 'src', 'renderer', 'models');
const outDir = path.join(root, 'test-output');

ort.env.wasm.numThreads = 1;

// ---------- WAV ----------
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('не WAV');
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('нет fmt');
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let acc = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const off = body + (i * fmt.channels + c) * bytes;
          if (fmt.format === 3 && fmt.bits === 32) acc += buf.readFloatLE(off);
          else if (fmt.bits === 16) acc += buf.readInt16LE(off) / 32768;
          else throw new Error(`формат WAV не поддерживается: ${fmt.format}/${fmt.bits}`);
        }
        out[i] = acc / fmt.channels;
      }
      return { rate: fmt.rate, samples: out };
    }
    pos = body + size + (size & 1);
  }
  throw new Error('нет data');
}

function writeWav(file, samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

function resampleLinear(x, from, to) {
  if (from === to) return x;
  const out = new Float32Array(Math.floor((x.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const t = (i * from) / to;
    const i0 = Math.floor(t);
    const f = t - i0;
    out[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? 0) * f;
  }
  return out;
}

// ---------- сигналы ----------
let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

function syntheticVoice(seconds) {
  // Гармонический сигнал с плавающим тоном и паузами — грубая имитация речи
  const n = seconds * SAMPLE_RATE;
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const f0 = 140 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += (2 * Math.PI * f0) / SAMPLE_RATE;
    const envelope = Math.max(0, Math.sin(2 * Math.PI * 0.45 * t)) ** 0.5;
    let s = 0;
    for (let h = 1; h <= 25; h++) s += Math.sin(h * phase) / h;
    x[i] = 0.12 * envelope * s;
  }
  return x;
}

function pinkishNoise(n) {
  // Белый шум + немного «гула» 50 Гц (типичный фон вентилятора/наводки)
  const out = new Float32Array(n);
  let b = 0;
  for (let i = 0; i < n; i++) {
    b = 0.97 * b + 0.03 * gauss();
    out[i] = 0.6 * gauss() + 2.5 * b + 0.2 * Math.sin((2 * Math.PI * 50 * i) / SAMPLE_RATE);
  }
  return out;
}

function keyboardClicks(n) {
  // Щелчки клавиш: короткие затухающие всплески широкополосного шума через 60–400 мс
  const out = new Float32Array(n);
  for (let at = 0; at < n; at += Math.round(SAMPLE_RATE * (0.06 + 0.34 * rand()))) {
    const amp = 2 + 3 * rand();
    for (let k = 0; k < 1200 && at + k < n; k++) out[at + k] += amp * gauss() * Math.exp(-k / 150);
  }
  return out;
}

function humanNoises(n) {
  // Звуки, которые шумодав принимает за голос: шмыганье (резкий полосовой шум, 250 мс)
  // и скрип механизма кресла (тон с гармониками 700→1100 Гц с дрожанием, 400 мс), каждые 0,6–1,4 с
  const out = new Float32Array(n);
  for (let at = 4800; at < n; at += Math.round(SAMPLE_RATE * (0.6 + 0.8 * rand()))) {
    if (rand() < 0.5) {
      const len = 0.25 * SAMPLE_RATE;
      let lp = 0;
      for (let k = 0; k < len && at + k < n; k++) {
        const env = k < 0.05 * SAMPLE_RATE ? k / (0.05 * SAMPLE_RATE) : Math.exp(-(k - 0.05 * SAMPLE_RATE) / (0.06 * SAMPLE_RATE));
        const w = gauss();
        lp = 0.7 * lp + 0.3 * w;
        out[at + k] += 1.5 * env * (w - lp);
      }
    } else {
      const len = 0.4 * SAMPLE_RATE;
      let phase = 0;
      for (let k = 0; k < len && at + k < n; k++) {
        const t = k / SAMPLE_RATE;
        phase += (2 * Math.PI * (700 + 1000 * t + 30 * Math.sin(2 * Math.PI * 9 * t))) / SAMPLE_RATE;
        const env = Math.sin((Math.PI * k) / len) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 13 * t));
        let s = 0;
        for (let h = 1; h <= 6; h++) s += Math.sin(h * phase) / h;
        out[at + k] += env * s;
      }
    }
  }
  return out;
}

function toiletFlush(n) {
  // Смыв унитаза: каждые 7 с поток воды на 4 с (полосовой шум 150–4000 Гц с турбулентной модуляцией),
  // бульканье (пузыри — затухающие тоны 300–2000 Гц с восходящим тоном, ~40 в секунду) и низкий гул
  const out = new Float32Array(n);
  const len = 4 * SAMPLE_RATE;
  for (let at = SAMPLE_RATE; at < n; at += 7 * SAMPLE_RATE) {
    let lo = 0;
    let hi = 0;
    let mod = 0;
    let rumble = 0;
    for (let k = 0; k < len && at + k < n; k++) {
      const t = k / SAMPLE_RATE;
      const env = Math.min(1, t / 0.25) * (t > 2.5 ? Math.exp(-(t - 2.5) / 0.5) : 1);
      const w = gauss();
      hi = 0.55 * hi + 0.45 * w; // срез верхов ~4 кГц
      lo = 0.98 * lo + 0.02 * hi; // срез низов ~150 Гц
      mod = 0.999 * mod + 0.001 * gauss() * 30;
      rumble = 0.995 * rumble + 0.005 * gauss();
      out[at + k] += env * ((hi - lo) * (0.7 + 0.5 * Math.tanh(mod)) + 6 * rumble);
    }
    for (let b = 0; b < 160; b++) {
      const start = at + Math.round(rand() * len * 0.9);
      const f0 = 300 + 1700 * rand() ** 2;
      const tau = (0.005 + 0.025 * rand()) * SAMPLE_RATE;
      const amp = 0.3 + 0.7 * rand();
      let phase = 0;
      for (let k = 0; k < 6 * tau && start + k < n; k++) {
        phase += (2 * Math.PI * f0 * (1 + (0.3 * k) / tau)) / SAMPLE_RATE;
        out[start + k] += amp * Math.exp(-k / tau) * Math.sin(phase);
      }
    }
  }
  return out;
}

const energy = (x, from = 0, to = x.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return e;
};
const db = (v) => 10 * Math.log10(v);

function siSdr(estimate, clean) {
  let dot = 0;
  for (let i = 0; i < clean.length; i++) dot += estimate[i] * clean[i];
  const alpha = dot / energy(clean);
  let target = 0;
  let noise = 0;
  for (let i = 0; i < clean.length; i++) {
    const t = alpha * clean[i];
    target += t * t;
    noise += (estimate[i] - t) ** 2;
  }
  return db(target / noise);
}

function bestLag(output, clean, maxLag) {
  let best = 0;
  let bestScore = -Infinity;
  const len = Math.min(clean.length, output.length - maxLag);
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let s = 0;
    for (let i = 0; i < len; i += 4) s += output[i + lag] * clean[i];
    if (s > bestScore) {
      bestScore = s;
      best = lag;
    }
  }
  return best;
}

// ---------- 1. ресемплеры ----------
function checkResamplers() {
  const tone = (hz, n) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));
  const run = (x) => {
    const dec = new Decimator3();
    const int = new Interpolator3();
    const out = new Float32Array(x.length);
    for (let i = 0; i + FRAME_48K <= x.length; i += FRAME_48K) {
      out.set(int.process(dec.process(x.subarray(i, i + FRAME_48K))), i);
    }
    return out;
  };
  const n = SAMPLE_RATE;
  const tail = (x) => Math.sqrt(energy(x, n / 2, n) / (n / 2)) * Math.SQRT2; // амплитуда по второй половине
  const pass = tail(run(tone(1000, n)));
  const stop = tail(run(tone(12000, n)));
  console.log(`Ресемплер 48→16→48 кГц: 1 кГц → амплитуда ${pass.toFixed(4)}, 12 кГц → ${db(stop * stop).toFixed(1)} дБ`);
  if (Math.abs(pass - 1) > 0.01 || stop > 0.001) throw new Error('ресемплер работает неправильно');
}

// ---------- 2. шумодав ----------
async function createDenoiser(model, limitDb, gate) {
  if (model === 'dtln') {
    checkResamplers();
    const dir = path.join(modelsDir, 'dtln');
    const engine = await DtlnEngine.create(
      ort,
      fs.readFileSync(path.join(dir, 'model_1.onnx')),
      fs.readFileSync(path.join(dir, 'model_2.onnx')),
    );
    return { denoiser: new Denoiser48k(engine), frame: FRAME_48K };
  }
  const dfn = await DfnDenoiser.create(ort, fs.readFileSync(path.join(modelsDir, 'dfn3', 'denoiser_model.onnx')));
  dfn.setAttenuationLimit(limitDb);
  if (!gate) return { denoiser: dfn, frame: DFN_FRAME };
  const voiceGate = new VoiceGate();
  const vad = await SileroVad.create(ort, fs.readFileSync(path.join(modelsDir, 'silero', 'silero_vad.onnx')));
  const denoiser = {
    process: async (frame) => {
      const prob = await vad.push(frame);
      const out = await dfn.process(frame);
      voiceGate.observe(frame, out);
      return voiceGate.process(out, voiceGate.speechByVad(prob));
    },
  };
  return { denoiser, frame: DFN_FRAME };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
  const [speechFile, snrArg] = args.filter((a) => !a.startsWith('--'));
  const model = flag('model', 'dfn3');
  const limitDb = Number(flag('limit', 0));
  const snrDb = Number(snrArg ?? 5);
  const gate = args.includes('--gate');
  const { denoiser, frame } = await createDenoiser(model, limitDb, gate);
  console.log(
    `Модель: ${model === 'dtln' ? 'DTLN (16 кГц)' : `DeepFilterNet3 (48 кГц), предел подавления ${limitDb || 'нет'}${gate ? ', голосовой порог' : ''}`}`,
  );
  let clean;
  if (speechFile) {
    const wav = readWav(speechFile);
    clean = resampleLinear(wav.samples, wav.rate, SAMPLE_RATE);
    console.log(`Речь: ${speechFile} (${wav.rate} Гц, ${(clean.length / SAMPLE_RATE).toFixed(1)} с)`);
  } else {
    clean = syntheticVoice(8);
    console.log('Речь: синтетический сигнал (передайте WAV с голосом для реалистичной оценки)');
  }
  clean = clean.subarray(0, clean.length - (clean.length % frame));

  const noiseKind = flag('noise', 'fan');
  const noise =
    { keys: keyboardClicks, human: humanNoises, flush: toiletFlush }[noiseKind]?.(clean.length) ?? pinkishNoise(clean.length);
  const gain = Math.sqrt(energy(clean) / energy(noise) / 10 ** (snrDb / 10));
  const noisy = Float32Array.from(clean, (s, i) => s + gain * noise[i]);

  const output = new Float32Array(noisy.length);
  const started = performance.now();
  for (let i = 0; i < noisy.length; i += frame) {
    output.set(await denoiser.process(noisy.subarray(i, i + frame)), i);
  }
  const elapsed = performance.now() - started;
  const frames = noisy.length / frame;
  const frameMs = (frame / SAMPLE_RATE) * 1000;

  const lag = bestLag(output, clean, 4800);
  const aligned = output.subarray(lag);
  const ref = clean.subarray(0, aligned.length);
  const noisyRef = noisy.subarray(0, aligned.length);

  // Подавление шума там, где «голос» молчит
  let inNoise = 0;
  let outNoise = 0;
  const win = 960;
  for (let i = 0; i + win <= ref.length; i += win) {
    if (energy(ref, i, i + win) < 1e-6 * win) {
      inNoise += energy(noisyRef, i, i + win);
      outNoise += energy(aligned, i, i + win);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  writeWav(path.join(outDir, 'noisy.wav'), noisy, SAMPLE_RATE);
  writeWav(path.join(outDir, 'denoised.wav'), output, SAMPLE_RATE);

  const sdrIn = siSdr(noisyRef, ref);
  const sdrOut = siSdr(aligned, ref);
  console.log(`SNR на входе: ${snrDb} дБ`);
  console.log(`Задержка тракта: ${lag} отсчётов = ${((lag / SAMPLE_RATE) * 1000).toFixed(1)} мс`);
  console.log(`SI-SDR: вход ${sdrIn.toFixed(2)} дБ → выход ${sdrOut.toFixed(2)} дБ (улучшение ${(sdrOut - sdrIn).toFixed(2)} дБ)`);
  if (inNoise > 0) console.log(`Шум в паузах подавлен на ${db(inNoise / outNoise).toFixed(1)} дБ`);
  console.log(
    `Скорость: ${(elapsed / frames).toFixed(3)} мс на кадр ${frameMs} мс (${((elapsed / frames / frameMs) * 100).toFixed(1)}% реального времени)`,
  );
  console.log(`WAV-файлы: ${path.relative(process.cwd(), outDir)}`);

  // С записью речи шумодав обязан улучшить сигнал. Синтетический «голос» DeepFilterNet3 глушит как гудок,
  // поэтому для него проверяется только подавление шума в паузах (так тест годится для CI без записей)
  const suppressedDb = inNoise > 0 ? db(inNoise / outNoise) : 0;
  if (speechFile ? !(sdrOut > sdrIn) : !(suppressedDb >= 10)) {
    console.error(speechFile ? 'ОШИБКА: шумодав не улучшил сигнал' : 'ОШИБКА: шумодав не подавил шум в паузах');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
