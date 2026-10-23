// Собственный захват (до 120 FPS): main присылает кадры-текстуры (sharedTexture), здесь из них
// получаются VideoFrame на GPU и пишутся в MediaStreamTrackGenerator — обычный видеотрек для WebRTC.

const bridge = () => window.duo.nativeCapture;

export async function nativeCaptureStatus() {
  if (typeof MediaStreamTrackGenerator !== 'function') return { available: false, reason: 'нет MediaStreamTrackGenerator' };
  try {
    return await bridge().status();
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

export class NativeCaptureTrack {
  constructor() {
    this.session = null;
    this.frames = 0;
    this.stopped = false;
  }

  /** @returns {Promise<MediaStream>} поток с одним видеотреком */
  async start(sourceId, { fps, contentHint }) {
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    generator.contentHint = contentHint;
    const writer = generator.writable.getWriter();
    this.generator = generator;

    // Кадры приходят ещё до ответа на start (по первому кадру main и понимает, что захват работает)
    bridge().onFrame(async (imported, session) => {
      if (this.stopped || (this.session !== null && session !== this.session)) return;
      const source = imported.getVideoFrame();
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
        await writer.write(frame);
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

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.session !== null) bridge().stop(this.session);
    this.generator?.stop();
  }
}
