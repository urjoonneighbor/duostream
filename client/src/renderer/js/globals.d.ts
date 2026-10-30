// Глобальные объекты окна интерфейса
import type { DuoApi } from '../../shared/duo-api';

declare global {
  interface Window {
    /** Мост к главному процессу (src/preload/preload.ts) */
    duo: DuoApi;
  }

  /** Состояние приложения для отладки из DevTools и проверок (js/app.ts) */
  var duoDebug: unknown;

  // Chromium: экспериментальные API, которых ещё нет в lib.dom.d.ts
  interface HTMLMediaElement {
    setSinkId(sinkId: string): Promise<void>;
  }
  interface AudioContext {
    setSinkId(sinkId: string | { type: 'none' }): Promise<void>;
  }
  interface MediaStreamTrackGeneratorInit {
    kind: 'audio' | 'video';
  }
  /** Видео- или звуковая дорожка, в которую пишут кадры (insertable streams) */
  class MediaStreamTrackGenerator extends MediaStreamTrack {
    constructor(init: MediaStreamTrackGeneratorInit);
    readonly writable: WritableStream<VideoFrame | AudioData>;
  }
  /** Кадры дорожки как поток (insertable streams) */
  class MediaStreamTrackProcessor<T extends VideoFrame | AudioData = VideoFrame> {
    constructor(init: { track: MediaStreamTrack; maxBufferSize?: number });
    readonly readable: ReadableStream<T>;
  }
  interface RTCRtpReceiver {
    /** Целевая задержка буфера, мс; null — автоматически */
    jitterBufferTarget: number | null;
  }
}
