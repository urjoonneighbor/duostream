// Собственный захват (до 120 FPS): main присылает кадры-текстуры (sharedTexture), здесь из них
// получаются VideoFrame на GPU и пишутся в MediaStreamTrackGenerator — обычный видеотрек для WebRTC.
// Статичный источник процесс захвата сам повторяет 10 раз в секунду (см. RepeatLastFrame в Program.cs).
import type { ContentHint } from '../../shared/config';
import type { NativeCaptureStatus } from '../../shared/duo-api';

const bridge = () => window.duo.nativeCapture;

export async function nativeCaptureStatus(): Promise<NativeCaptureStatus> {
  if (typeof MediaStreamTrackGenerator !== 'function') return { available: false, reason: 'нет MediaStreamTrackGenerator' };
  try {
    return await bridge().status();
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}

export class NativeCaptureTrack {
  session: number | null = null;
  frames = 0;
  stopped = false;
  width = 0;
  height = 0;
  adapter = '';
  lastFrameInfo = '';
  private generator: MediaStreamTrackGenerator | null = null;
  private writes = { count: 0, totalMs: 0, maxMs: 0 };

  /** Сколько ждёт запись кадра в видеотрек: долго — не успевает энкодер (обратное давление трека) */
  private noteWrite(ms: number): void {
    const w = this.writes;
    w.count++;
    w.totalMs += ms;
    w.maxMs = Math.max(w.maxMs, ms);
  }

  /** Средняя и максимальная задержка записи с прошлого вызова */
  takeWriteStats(): { avgMs: number; maxMs: number } {
    const w = this.writes;
    this.writes = { count: 0, totalMs: 0, maxMs: 0 };
    return { avgMs: w.count ? w.totalMs / w.count : 0, maxMs: w.maxMs };
  }

  /** Поток с одним видеотреком */
  async start(sourceId: string, { fps, contentHint }: { fps: number; contentHint: ContentHint }): Promise<MediaStream> {
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    generator.contentHint = contentHint;
    const writer = generator.writable.getWriter();
    this.generator = generator;

    // Кадры приходят ещё до ответа на start (по первому кадру main и понимает, что захват работает)
    bridge().onFrame(async (imported, session) => {
      if (this.stopped || (this.session !== null && session !== this.session)) return;
      const source = imported.getVideoFrame() as VideoFrame;
      // Electron задаёт размер показа равным всей текстуре (кольцо с запасом под рост окна), и WebRTC
      // растянул бы видимую часть на всю текстуру. Обёртка без копирования: та же текстура, верный размер.
      const r = source.visibleRect;
      const frame =
        r && (r.width !== source.displayWidth || r.height !== source.displayHeight)
          ? new VideoFrame(source, {
              visibleRect: { x: r.x, y: r.y, width: r.width, height: r.height },
              displayWidth: r.width,
              displayHeight: r.height,
            })
          : source;
      try {
        if (this.frames % 120 === 0) {
          this.lastFrameInfo = `текстура ${frame.codedWidth}×${frame.codedHeight}, кадр ${frame.displayWidth}×${frame.displayHeight}`;
        }
        const started = performance.now();
        await writer.write(frame);
        this.noteWrite(performance.now() - started);
        this.frames++;
      } catch {
        // трек остановлен
      } finally {
        frame.close();
        if (frame !== source) source.close();
      }
    });

    const result = await bridge().start(sourceId, fps);
    if (!result.ok) {
      this.stop();
      throw new Error(result.error);
    }
    Object.assign(this, { session: result.session, width: result.width, height: result.height, adapter: result.adapter });
    return new MediaStream([generator]);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.session !== null) void bridge().stop(this.session);
    this.generator?.stop();
  }
}
