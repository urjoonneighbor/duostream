// Собственный захват (до 120 FPS): main присылает кадры-текстуры (sharedTexture), здесь из них
// получаются VideoFrame на GPU и пишутся в MediaStreamTrackGenerator — обычный видеотрек для WebRTC.
// Статичный источник процесс захвата сам повторяет 10 раз в секунду (см. RepeatLastFrame в Program.cs).
import type { ContentHint } from '../../shared/config';
import type { NativeCaptureStatus } from '../../shared/duo-api';

const bridge = () => window.duo.nativeCapture;

/** Сессии, у которых уже есть свой трек: новый трек, ещё не знающий номер своей сессии, их кадры не берёт */
const claimedSessions = new Set<number>();

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
  private unsubscribe: (() => void) | null = null;
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
    this.unsubscribe = bridge().onFrame(async (imported, session, width, height) => {
      if (this.stopped) return;
      if (this.session !== null ? session !== this.session : claimedSessions.has(session)) return;
      const source = imported.getVideoFrame() as VideoFrame;
      // Видимая часть — по размеру от процесса захвата, а не по source.visibleRect: Chromium кэширует
      // импорт по хэндлу текстуры, и слот кольца, импортированный раньше при другом размере окна, приходит
      // со старым visibleRect. Окно уменьшилось (например, вышло из полноэкранного режима) — и каждый
      // такой слот показывал бы снизу и справа остатки прежней картинки: мелькание.
      // Кроме того, Electron задаёт размер показа равным всей текстуре: пока кольцо после уменьшения окна
      // не пересоздано (Program.cs, RingShrinkMs), WebRTC растянул бы её целиком. Обёртка без копирования.
      const r = source.visibleRect;
      const w = Math.min(width || r?.width || source.codedWidth, source.codedWidth);
      const h = Math.min(height || r?.height || source.codedHeight, source.codedHeight);
      const frame =
        !r || r.x !== 0 || r.y !== 0 || r.width !== w || r.height !== h || source.displayWidth !== w || source.displayHeight !== h
          ? new VideoFrame(source, { visibleRect: { x: 0, y: 0, width: w, height: h }, displayWidth: w, displayHeight: h })
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
    claimedSessions.add(result.session);
    return new MediaStream([generator]);
  }

  /** Предельная частота кадров — сразу, без перезапуска захвата */
  async setFps(fps: number): Promise<boolean> {
    return this.session !== null && !this.stopped && (await bridge().setFps(this.session, fps));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    if (this.session !== null) {
      claimedSessions.delete(this.session);
      void bridge().stop(this.session);
    }
    this.generator?.stop();
  }
}
