// Web Worker шумодава: ONNX Runtime (WASM) + DeepFilterNet3 (48 кГц) или DTLN (16 кГц).
// Кадры приходят напрямую из AudioWorklet через MessagePort (минуя главный поток)
// и уходят обратно тем же путём.
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { DtlnEngine, Denoiser48k, FRAME_48K } from './dtln-core.ts';
import { DfnDenoiser, DFN_FRAME, VoiceGate } from './dfn-core.ts';
import { SileroVad } from './vad-core.ts';
import type { DenoiseModel } from '../../shared/config';
import type { WorkerCommand, WorkerMessage } from './messages';

ort.env.wasm.numThreads = 1; // кадр 10 мс считается за ~2 мс — потоки и SharedArrayBuffer не нужны
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;

const MAX_QUEUE_MS = 100; // если воркер не успевает, старые кадры выбрасываются

/** Загруженная модель: кадр, шумодав и (у DeepFilterNet3) распознаватель речи для порога */
interface Instance {
  frame: number;
  denoiser: DfnDenoiser | Denoiser48k;
  vad?: SileroVad | null;
}
type Engine = Instance & { model: DenoiseModel };

/** Кадр от AudioWorklet (audio/denoise-worklet.ts) */
type WorkletMessage = { type: 'frame'; data: Float32Array } | { type: 'reset' };

const MODELS: Record<DenoiseModel, () => Promise<Instance>> = {
  dfn3: async () => ({
    frame: DFN_FRAME,
    denoiser: await DfnDenoiser.create(ort, await loadModel('dfn3/denoiser_model.onnx')),
    // Распознаватель речи для голосового порога; без него порог работает по оценке SNR DeepFilterNet3
    vad: await loadModel('silero/silero_vad.onnx')
      .then((model) => SileroVad.create(ort, model))
      .catch(() => null),
  }),
  dtln: async () => {
    const [m1, m2] = await Promise.all([loadModel('dtln/model_1.onnx'), loadModel('dtln/model_2.onnx')]);
    return { frame: FRAME_48K, denoiser: new Denoiser48k(await DtlnEngine.create(ort, m1, m2)) };
  },
};

const loaded = new Map<DenoiseModel, Instance>(); // уже загруженные модели: переключение туда-обратно без повторной загрузки
let engine: Engine | null = null;
let options = { limitDb: 0, gate: true };
const gate = new VoiceGate();
let loadToken = 0;
let port: MessagePort | null = null;
let busy = false;
const queue: Float32Array[] = [];
let stats = { frames: 0, totalMs: 0, maxMs: 0, dropped: 0, gateOpen: 0 };

const post = (msg: WorkerMessage) => self.postMessage(msg);

async function loadModel(name: string): Promise<ArrayBuffer> {
  const response = await fetch(new URL(`../models/${name}`, import.meta.url));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function load(model: DenoiseModel): Promise<Instance> {
  let instance = loaded.get(model);
  if (!instance) {
    instance = await MODELS[model]();
    // Прогрев: первый прогон сессии заметно медленнее последующих
    await instance.denoiser.process(new Float32Array(instance.frame));
    loaded.set(model, instance);
  }
  return instance;
}

async function selectModel(requested: DenoiseModel): Promise<void> {
  const token = ++loadToken;
  engine = null;
  queue.length = 0;
  let model: DenoiseModel = MODELS[requested] ? requested : 'dfn3';
  let warning = '';
  let instance: Instance;
  try {
    instance = await load(model);
  } catch (err) {
    if (model !== 'dfn3') throw err;
    // DeepFilterNet3 не загрузился (нет файла модели, мало памяти) — лёгкая модель лучше, чем ничего
    warning = `DeepFilterNet3 не загрузился (${(err as Error)?.message ?? err}), работает DTLN`;
    model = 'dtln';
    instance = await load(model);
  }
  if (token !== loadToken) return;
  instance.denoiser.reset();
  instance.vad?.reset();
  gate.reset();
  engine = { model, ...instance };
  applyOptions();
  post({ type: 'ready', model, frame: instance.frame, vad: Boolean(instance.vad), warning });
}

function applyOptions(): void {
  if (engine?.denoiser instanceof DfnDenoiser) engine.denoiser.setAttenuationLimit(options.limitDb);
}

function onWorkletMessage(event: MessageEvent<WorkletMessage>): void {
  const msg = event.data;
  if (msg.type === 'frame') {
    if (!engine || msg.data.length !== engine.frame) return; // кадр от прежней модели при переключении
    if (queue.length * engine.frame >= (MAX_QUEUE_MS / 1000) * 48000) {
      queue.shift();
      stats.dropped++;
    }
    queue.push(msg.data);
    void drain();
  } else if (msg.type === 'reset') {
    queue.length = 0;
    engine?.denoiser.reset();
    engine?.vad?.reset();
    gate.reset();
  }
}

async function drain(): Promise<void> {
  if (busy || !engine) return;
  busy = true;
  try {
    while (queue.length && engine) {
      const { denoiser, vad } = engine;
      const frame = queue.shift()!;
      const started = performance.now();
      const out = await denoiser.process(frame);
      if (denoiser instanceof DfnDenoiser && options.gate) {
        // Речь или нет — по входу: очищенный звук отстаёт на 30 мс, порог успевает открыться к слову
        gate.observe(frame, out);
        const speech = vad ? gate.speechByVad(await vad.push(frame)) : gate.speechByLsnr(denoiser.lsnr);
        gate.process(out, speech);
        if (gate.open) stats.gateOpen++;
      }
      const ms = performance.now() - started;
      stats.frames++;
      stats.totalMs += ms;
      stats.maxMs = Math.max(stats.maxMs, ms);
      port?.postMessage({ type: 'frame', data: out }, [out.buffer]);
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  } finally {
    busy = false;
  }
}

setInterval(() => {
  if (!stats.frames) return;
  post({
    type: 'stats',
    avgMs: stats.totalMs / stats.frames,
    maxMs: stats.maxMs,
    dropped: stats.dropped,
    gateOpen: stats.gateOpen / stats.frames,
  });
  stats = { frames: 0, totalMs: 0, maxMs: 0, dropped: 0, gateOpen: 0 };
}, 2000);

self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const msg = event.data;
  if (msg?.type === 'init') {
    port = msg.port;
    port.onmessage = onWorkletMessage;
  }
  if (msg?.type === 'init' || msg?.type === 'options') {
    options = { limitDb: msg.limitDb ?? options.limitDb, gate: msg.gate ?? options.gate };
    applyOptions();
  }
  if (msg?.type === 'init' || msg?.type === 'model') {
    selectModel(msg.model).catch((err) => post({ type: 'error', message: String(err?.message ?? err) }));
  }
};
