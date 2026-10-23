// AudioWorklet: режет микрофон на кадры по 8 мс, отдаёт их воркеру шумодава и
// воспроизводит очищенный звук из кольцевого буфера. Пока шумодав выключен или
// не загрузился — звук проходит насквозь без задержки.
const FRAME = 384; // 8 мс @ 48 кГц = один шаг DTLN (128 отсчётов @ 16 кГц)
const FIFO_SIZE = 48000;
const PREFILL = FRAME * 2; // запас 16 мс на неравномерность ответа воркера
const MAX_BACKLOG = PREFILL + FRAME * 4;

class DuoDenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.worker = null;
    this.frame = new Float32Array(FRAME);
    this.fifo = new Float32Array(FIFO_SIZE);
    this.underruns = 0;
    this.lastReport = 0;
    this.resetBuffers();
    this.port.onmessage = (event) => this.onControl(event.data);
  }

  resetBuffers() {
    this.framePos = 0;
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.primed = false;
  }

  onControl(msg) {
    if (msg.type === 'worker-port') {
      this.worker = msg.port;
      this.worker.onmessage = (event) => {
        if (event.data.type === 'frame') this.push(event.data.data);
      };
    } else if (msg.type === 'enable') {
      const on = Boolean(msg.value) && this.worker !== null;
      if (on === this.enabled) return;
      this.enabled = on;
      this.resetBuffers();
      if (on) this.worker.postMessage({ type: 'reset' });
    }
  }

  push(samples) {
    if (!this.enabled) return;
    for (let i = 0; i < samples.length && this.count < FIFO_SIZE; i++) {
      this.fifo[this.write] = samples[i];
      this.write = (this.write + 1) % FIFO_SIZE;
      this.count++;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    const input = inputs[0]?.[0];
    if (!input) {
      output.fill(0);
      return true;
    }
    if (!this.enabled) {
      output.set(input);
      return true;
    }

    for (let i = 0; i < input.length; ) {
      const n = Math.min(input.length - i, FRAME - this.framePos);
      this.frame.set(input.subarray(i, i + n), this.framePos);
      this.framePos += n;
      i += n;
      if (this.framePos === FRAME) {
        const copy = this.frame.slice();
        this.worker.postMessage({ type: 'frame', data: copy }, [copy.buffer]);
        this.framePos = 0;
      }
    }

    if (!this.primed) {
      if (this.count < PREFILL) {
        output.fill(0);
        return true;
      }
      this.primed = true;
    }
    if (this.count < output.length) {
      output.fill(0);
      this.primed = false;
      this.underruns++;
    } else {
      for (let k = 0; k < output.length; k++) {
        output[k] = this.fifo[this.read];
        this.read = (this.read + 1) % FIFO_SIZE;
      }
      this.count -= output.length;
      // Если воркер отдал кадры пачкой после подвисания — срезаем лишнее, чтобы задержка не копилась
      if (this.count > MAX_BACKLOG) {
        const drop = this.count - PREFILL;
        this.read = (this.read + drop) % FIFO_SIZE;
        this.count -= drop;
      }
    }

    if (currentTime - this.lastReport > 2) {
      this.lastReport = currentTime;
      this.port.postMessage({ type: 'stats', underruns: this.underruns });
    }
    return true;
  }
}

registerProcessor('duo-denoise', DuoDenoiseProcessor);
