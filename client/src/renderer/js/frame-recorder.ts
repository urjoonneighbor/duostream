// «Отметить глюк»: последние ~2 с кадров видеотрека в памяти видеокарты (уменьшенные до 960 px),
// по команде — в JPEG рядом с журналом. У зрителя пишутся декодированные кадры, у стримера — захваченные
// (до кодирования). Отметка сохраняет кадры у обоих сразу, и по ним видно, где рождается глюк:
//   есть в кадрах стримера — при захвате;  только у зрителя — в сети или декодере;
//   ни у кого нет, а на экране был — при выводе на экран у зрителя.

const WIDTH = 960;
const KEEP_MS = 2000;
const MAX_FRAMES = 150; // 2 с при 75 к/с; при 120 к/с — последние 1,25 с

import type { LogFrame } from '../../shared/duo-api';

export class FrameRecorder {
  frames: { bitmap: ImageBitmap; at: number }[] = [];
  private track: MediaStreamTrack | null = null;
  private clone: MediaStreamTrack | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;

  /** Начать запись кадров трека (копии: исходный трек не трогаем); null — остановить */
  attach(track: MediaStreamTrack | null): void {
    if (track === this.track) return;
    this.detach();
    if (!track || typeof MediaStreamTrackProcessor !== 'function') return;
    this.track = track;
    const clone = track.clone();
    this.clone = clone;
    const reader = new MediaStreamTrackProcessor<VideoFrame>({ track: clone, maxBufferSize: 2 }).readable.getReader();
    this.reader = reader;
    void (async () => {
      for (;;) {
        const { value: frame, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
        if (done || !frame || this.reader !== reader) {
          frame?.close();
          return;
        }
        try {
          const height = Math.round((WIDTH * frame.displayHeight) / frame.displayWidth / 2) * 2;
          const bitmap = await createImageBitmap(frame, { resizeWidth: WIDTH, resizeHeight: height, resizeQuality: 'medium' });
          this.add(bitmap);
        } catch {
          // кадр недоступен (трек сменился) — пропускаем
        } finally {
          frame.close();
        }
      }
    })();
  }

  detach(): void {
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    this.clone?.stop();
    this.clone = null;
    this.track = null;
    for (const f of this.frames) f.bitmap.close();
    this.frames = [];
  }

  private add(bitmap: ImageBitmap): void {
    const now = performance.now();
    this.frames.push({ bitmap, at: now });
    while (this.frames.length > MAX_FRAMES || (this.frames.length && now - this.frames[0].at > KEEP_MS)) {
      this.frames.shift()!.bitmap.close();
    }
  }

  /** Накопленные кадры → [{name, data: ArrayBuffer JPEG}]. Забирает их: запись тут же копит новые */
  async dump(): Promise<LogFrame[]> {
    const frames = this.frames;
    this.frames = [];
    const last = frames.at(-1)?.at ?? 0;
    const out: LogFrame[] = [];
    try {
      for (const [i, f] of frames.entries()) {
        const canvas = new OffscreenCanvas(f.bitmap.width, f.bitmap.height);
        canvas.getContext('2d')!.drawImage(f.bitmap, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
        // В имени — номер и сколько миллисекунд до последнего кадра (по ним видно пропуски)
        const ms = Math.round(last - f.at);
        out.push({ name: `${String(i).padStart(3, '0')}_-${String(ms).padStart(4, '0')}ms.jpg`, data: await blob.arrayBuffer() });
      }
    } finally {
      for (const f of frames) f.bitmap.close();
    }
    return out;
  }
}
