// Сообщения воркера шумодава (audio/denoise-worker.ts) — общие для воркера и MicPipeline (js/audio.ts)
import type { DenoiseModel } from '../../shared/config';

/** Интерфейс → воркер */
export type WorkerCommand =
  | { type: 'init'; port: MessagePort; model: DenoiseModel; limitDb: number; gate: boolean }
  | { type: 'options'; limitDb: number; gate: boolean }
  | { type: 'model'; model: DenoiseModel };

/** Воркер → интерфейс */
export type WorkerMessage =
  | { type: 'ready'; model: DenoiseModel; frame: number; vad: boolean; warning: string }
  | { type: 'error'; message: string }
  | { type: 'stats'; avgMs: number; maxMs: number; dropped: number; gateOpen: number };
