// AudioWorklet: проигрывает в граф Web Audio поток PCM, который приходит порциями извне (звук приложения
// окна от процесса захвата). Порции идут через stdout процесса захвата, main-процесс и IPC — под нагрузкой
// (кадры 60 FPS, тяжёлый плеер) они приходят неровно, с задержками в десятки миллисекунд. Поэтому:
//  - запас в буфере 100 мс: короткие задержки доставки не превращаются в дыры (на слух — треск);
//  - лишнее (часы звуковой карты и AudioContext чуть расходятся) убирается незаметно — пропуском одного
//    отсчёта из сотни, а не срезанием куска; срезается только завал больше 400 мс;
//  - если звук всё же кончился, он плавно гаснет, а после нового запаса плавно возвращается — без щелчков.
// Раз в 2 с в порт уходят счётчики: сколько было провалов и сколько срезано.
const CAPACITY = 48000 * 2; // кадров (2 с)
const TARGET = 4800; // 100 мс — столько набираем перед воспроизведением
const SOFT_MAX = 9600; // 200 мс — выше этого понемногу ускоряемся
const HARD_MAX = 19200; // 400 мс — выше этого срезаем до TARGET
const FADE = 240; // 5 мс — плавное появление и угасание
const SKIP_EVERY = 100; // при ускорении пропускаем 1 отсчёт из 100 (1 %, на слух незаметно)
const REPORT_FRAMES = 48000 * 2; // отчёт раз в 2 с

class DuoPcmPlayer extends AudioWorkletProcessor {
  private readonly ring = new Float32Array(CAPACITY * 2);
  private read = 0;
  private write = 0;
  private count = 0;
  private primed = false;
  private fadeIn = 0; // сколько кадров плавного появления осталось
  private skipPhase = 0;
  private underruns = 0;
  private trimmedFrames = 0;
  private sinceReport = 0;

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

  private take(): [number, number] {
    const j = this.read * 2;
    this.read = (this.read + 1) % CAPACITY;
    this.count--;
    return [this.ring[j], this.ring[j + 1]];
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0];
    const n = left.length;
    this.report(n);
    if (!this.primed) {
      left.fill(0);
      right.fill(0);
      if (this.count >= TARGET) {
        this.primed = true;
        this.fadeIn = FADE;
      }
      return true;
    }
    if (this.count > HARD_MAX) {
      const drop = this.count - TARGET;
      this.read = (this.read + drop) % CAPACITY;
      this.count -= drop;
      this.trimmedFrames += drop;
      this.fadeIn = FADE;
    }
    if (this.count < n) {
      // Звук кончился: приложение замолчало или доставка запоздала больше чем на 100 мс.
      // Остаток — с угасанием, дальше тишина до нового запаса
      const rest = this.count;
      for (let k = 0; k < n; k++) {
        if (k < rest) {
          const gain = (rest - k) / rest;
          const [l, r] = this.take();
          left[k] = l * gain;
          right[k] = r * gain;
        } else {
          left[k] = 0;
          right[k] = 0;
        }
      }
      this.primed = false;
      this.underruns++;
      return true;
    }
    const speedUp = this.count > SOFT_MAX;
    for (let k = 0; k < n; k++) {
      if (speedUp && ++this.skipPhase >= SKIP_EVERY && this.count > n - k + 1) {
        this.skipPhase = 0;
        this.take(); // пропуск одного отсчёта
        this.trimmedFrames++;
      }
      let [l, r] = this.take();
      if (this.fadeIn > 0) {
        const gain = 1 - this.fadeIn / FADE;
        l *= gain;
        r *= gain;
        this.fadeIn--;
      }
      left[k] = l;
      right[k] = r;
    }
    return true;
  }

  private report(frames: number): void {
    this.sinceReport += frames;
    if (this.sinceReport < REPORT_FRAMES) return;
    this.sinceReport = 0;
    this.port.postMessage({ underruns: this.underruns, trimmedMs: Math.round(this.trimmedFrames / 48), bufferedMs: Math.round(this.count / 48) });
  }
}

registerProcessor('duo-pcm-player', DuoPcmPlayer);

// Модуль, а не скрипт: константы ворклетов не попадают в общую глобальную область
export {};
