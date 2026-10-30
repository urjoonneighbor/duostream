// Глобальная область AudioWorklet (в TypeScript нет готовой библиотеки типов для неё)

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  /** inputs[вход][канал] и outputs[выход][канал] — блоки по 128 отсчётов; false — процессор больше не нужен */
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

/** Время AudioContext, с */
declare const currentTime: number;
declare const currentFrame: number;
declare const sampleRate: number;
