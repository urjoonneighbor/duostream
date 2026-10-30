// AudioWorklet: проигрывает в граф Web Audio поток PCM, который приходит порциями извне (звук приложения
// окна от процесса захвата). Кольцевой буфер сглаживает неравномерность доставки; задержка 40 мс,
// а если накопилось больше 150 мс (часы звуковой карты и AudioContext чуть расходятся) — лишнее срезается.
const CAPACITY = 48000 * 2; // кадров (2 с)
const PREFILL = 1920; // 40 мс
const MAX_BACKLOG = 7200; // 150 мс

class DuoPcmPlayer extends AudioWorkletProcessor {
  private readonly ring = new Float32Array(CAPACITY * 2);
  private read = 0;
  private write = 0;
  private count = 0;
  private primed = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<Float32Array>) => this.push(event.data);
  }

  /** @param data стерео с чередованием каналов */
  private push(data: Float32Array): void {
    const frames = data.length >> 1;
    for (let i = 0; i < frames && this.count < CAPACITY; i++) {
      const j = this.write * 2;
      this.ring[j] = data[2 * i];
      this.ring[j + 1] = data[2 * i + 1];
      this.write = (this.write + 1) % CAPACITY;
      this.count++;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0];
    const n = left.length;
    if (!this.primed && this.count < PREFILL) {
      left.fill(0);
      right.fill(0);
      return true;
    }
    this.primed = true;
    if (this.count < n) {
      // Приложение молчит (Windows не присылает пакеты) или доставка запоздала — тишина и снова запас
      left.fill(0);
      right.fill(0);
      this.primed = false;
      return true;
    }
    for (let k = 0; k < n; k++) {
      const j = this.read * 2;
      left[k] = this.ring[j];
      right[k] = this.ring[j + 1];
      this.read = (this.read + 1) % CAPACITY;
    }
    this.count -= n;
    if (this.count > MAX_BACKLOG) {
      const drop = this.count - PREFILL;
      this.read = (this.read + drop) % CAPACITY;
      this.count -= drop;
    }
    return true;
  }
}

registerProcessor('duo-pcm-player', DuoPcmPlayer);

// Модуль, а не скрипт: константы ворклетов не попадают в общую глобальную область
export {};
