// Silero VAD (MIT, github.com/snakers4/silero-vad) — вероятность речи в окне 32 мс на 16 кГц.
// DeepFilterNet3 убирает шум, но звуки, похожие на голос (скрип кресла, шмыганье, дыхание), оставляет:
// для него это не шум. Silero отличает речь от всего остального, по нему голосовой порог и глушит
// микрофон между фразами — как Krisp с автоматической чувствительностью в Discord.
// Работает и в Web Worker приложения, и в Node (scripts/test-denoiser.mts).
import { Decimator3 } from './dtln-core.ts';
import type { Ort, OrtSession, OrtTensor } from './ort-types.ts';

const WINDOW = 512; // 32 мс @ 16 кГц
const CONTEXT = 64; // Silero v5 ждёт перед окном 64 отсчёта предыдущего

export class SileroVad {
  /** @param model silero_vad.onnx */
  static async create(ort: Ort, model: ArrayBuffer | Uint8Array): Promise<SileroVad> {
    const session = await ort.InferenceSession.create(model instanceof Uint8Array ? model : new Uint8Array(model), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return new SileroVad(ort, session);
  }

  private readonly ort: Ort;
  private readonly session: OrtSession;
  private readonly input = new Float32Array(CONTEXT + WINDOW);
  private readonly sr: OrtTensor;
  private state!: OrtTensor;
  private decimator!: Decimator3;
  private fill = 0;
  /** Вероятность речи в последнем окне, 0..1 */
  prob = 0;

  constructor(ort: Ort, session: OrtSession) {
    this.ort = ort;
    this.session = session;
    this.sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
    this.reset();
  }

  reset(): void {
    this.state = new this.ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    this.decimator = new Decimator3();
    this.input.fill(0);
    this.fill = 0;
    this.prob = 0;
  }

  /** @param frame кадр 48 кГц, длина кратна 3; возвращает вероятность речи */
  async push(frame: Float32Array): Promise<number> {
    const x = this.decimator.process(frame);
    for (let i = 0; i < x.length; i++) {
      this.input[CONTEXT + this.fill++] = x[i];
      if (this.fill < WINDOW) continue;
      const result = await this.session.run({
        input: new this.ort.Tensor('float32', this.input.slice(), [1, CONTEXT + WINDOW]),
        state: this.state,
        sr: this.sr,
      });
      this.state = result.stateN;
      this.prob = (result.output.data as Float32Array)[0];
      this.input.copyWithin(0, WINDOW, WINDOW + CONTEXT); // хвост окна — контекст следующего
      this.fill = 0;
    }
    return this.prob;
  }
}
