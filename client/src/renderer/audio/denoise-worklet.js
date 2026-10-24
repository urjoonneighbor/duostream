// AudioWorklet: режет микрофон на кадры модели (DeepFilterNet3 — 10 мс, DTLN — 8 мс), отдаёт их
// воркеру шумодава и воспроизводит очищенный звук из кольцевого буфера. Пока шумодав выключен
// или не загрузился — звук проходит насквозь без задержки.
const FIFO_SIZE = 48000;
const SLACK = 384; // запас 8 мс сверх кадра на неравномерность ответа воркера

class DuoDenoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.worker = null;
    this.setFrameSize(480);
    this.fifo = new Float32Array(FIFO_SIZE);
    this.underruns = 0;
    this.lastReport = 0;
    this.resetBuffers();
    this.port.onmessage = (event) => this.onControl(event.data);
  }

  setFrameSize(size) {
    this.frame = new Float32Array(size);
    this.prefill = size + SLACK;
    this.maxBacklog = this.prefill + size * 4;
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
      const resize = on && msg.frame && msg.frame !== this.frame.length;
      if (on === this.enabled && !resize) return;
      if (resize) this.setFrameSize(msg.frame);
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

    const size = this.frame.length;
    for (let i = 0; i < input.length; ) {
      const n = Math.min(input.length - i, size - this.framePos);
      this.frame.set(input.subarray(i, i + n), this.framePos);
      this.framePos += n;
      i += n;
      if (this.framePos === size) {
        const copy = this.frame.slice();
        this.worker.postMessage({ type: 'frame', data: copy }, [copy.buffer]);
        this.framePos = 0;
      }
    }

    if (!this.primed) {
      if (this.count < this.prefill) {
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
      if (this.count > this.maxBacklog) {
        const drop = this.count - this.prefill;
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
