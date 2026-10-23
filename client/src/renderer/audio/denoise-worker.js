// Web Worker шумодава: ONNX Runtime (WASM) + DTLN. Кадры приходят напрямую из AudioWorklet
// через MessagePort (минуя главный поток) и уходят обратно тем же путём.
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { DtlnEngine, Denoiser48k, FRAME_48K } from './dtln-core.js';

ort.env.wasm.numThreads = 1; // модель крошечная, потоки и SharedArrayBuffer не нужны
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;

const MAX_QUEUE = 12; // ~100 мс; если воркер не успевает, старые кадры выбрасываются

let denoiser = null;
let port = null;
let busy = false;
const queue = [];
let stats = { frames: 0, totalMs: 0, maxMs: 0, dropped: 0 };

async function loadModel(name) {
  const response = await fetch(new URL(`../models/dtln/${name}`, import.meta.url));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function init(workletPort) {
  port = workletPort;
  port.onmessage = onWorkletMessage;
  try {
    const [m1, m2] = await Promise.all([loadModel('model_1.onnx'), loadModel('model_2.onnx')]);
    denoiser = new Denoiser48k(await DtlnEngine.create(ort, m1, m2));
    // Прогрев: первый прогон сессии заметно медленнее последующих
    await denoiser.process(new Float32Array(FRAME_48K));
    denoiser.reset();
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
}

function onWorkletMessage(event) {
  const msg = event.data;
  if (msg.type === 'frame') {
    if (queue.length >= MAX_QUEUE) {
      queue.shift();
      stats.dropped++;
    }
    queue.push(msg.data);
    drain();
  } else if (msg.type === 'reset') {
    queue.length = 0;
    denoiser?.reset();
  }
}

async function drain() {
  if (busy || !denoiser) return;
  busy = true;
  try {
    while (queue.length) {
      const frame = queue.shift();
      const started = performance.now();
      const out = await denoiser.process(frame);
      const ms = performance.now() - started;
      stats.frames++;
      stats.totalMs += ms;
      stats.maxMs = Math.max(stats.maxMs, ms);
      port.postMessage({ type: 'frame', data: out }, [out.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message ?? err) });
  } finally {
    busy = false;
  }
}

setInterval(() => {
  if (!stats.frames) return;
  self.postMessage({ type: 'stats', avgMs: stats.totalMs / stats.frames, maxMs: stats.maxMs, dropped: stats.dropped });
  stats = { frames: 0, totalMs: 0, maxMs: 0, dropped: 0 };
}, 2000);

self.onmessage = (event) => {
  if (event.data?.type === 'init') init(event.data.port);
};
