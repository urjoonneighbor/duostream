// Мост между интерфейсом и главным процессом: window.duo (src/preload/preload.ts).
// Общий тип для обеих сторон — preload реализует DuoApi, интерфейс вызывает его методы.
import type { Config, HotkeyAction, HotkeyBinding, OverlayCorner } from './config';

export type HotkeyPhase = 'down' | 'up';
export type LogLevel = 'info' | 'warn' | 'error';

/** Ответ на запуск того, что может не получиться: {ok:true, …} или {ok:false, error} */
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; code?: string | null };

export interface DesktopSource {
  id: string;
  name: string;
  type: 'screen' | 'window';
  /** data:image/jpeg… или null, если превью нет */
  thumbnail: string | null;
  icon: string | null;
}

export type NativeCaptureStatus = { available: true; path: string } | { available: false; reason: string };

export type NativeCaptureEvent =
  | { session: number; type: 'error'; message: string }
  | { session: number; type: 'size'; width: number; height: number }
  | { session: number; type: 'closed' }
  | {
      session: number;
      type: 'stats';
      fps: number;
      dropped: number;
      copyMs: number;
      inFlight: number;
      deliverMs: number;
      deliverMaxMs: number;
    };

/** Кадр собственного захвата, пришедший в окно (Electron sharedTexture). VideoFrame — тип DOM. */
export interface ImportedTexture {
  getVideoFrame(): object;
  release(): void;
}

export type UpdateStatus = 'dev' | 'off' | 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'available' | 'error';
export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  percent?: number;
  error?: string;
  current: string;
  portable: boolean;
  url: string;
}

export interface UpnpState {
  status: 'off' | 'working' | 'unavailable' | 'ok' | 'partial';
  router?: string;
  externalIp?: string | null;
  cgnat?: boolean;
  opened?: number;
  manual?: number;
  message?: string;
}

export interface HotkeysStatus {
  available: boolean;
  error: string;
}
export type HotkeyRecordResult = { binding: HotkeyBinding } | { cleared: true } | null;

/** Что видно в оверлее поверх игры (src/main/overlay.ts, src/renderer/overlay.html) */
export interface OverlayState {
  active: boolean;
  corner?: OverlayCorner;
  mic?: string;
  micOff?: boolean;
  meSpeaking?: boolean;
  peerName?: string | null;
  peerSpeaking?: boolean;
  peerState?: string;
  deafened?: boolean;
  stream?: string;
  message?: string | null;
}

export interface GpuSummary {
  devices: { vendor: string; deviceId: string; active: boolean; description: string }[];
  renderer: string;
  error?: string;
}

export interface AppInfo {
  versions: { app: string; electron: string; chrome: string };
  platform: string;
  gpu: GpuSummary;
  gpuFeatures: Record<string, string>;
  udpPortRange?: { min: number; max: number };
  nativeCapture: NativeCaptureStatus;
  hotkeys: HotkeysStatus;
  update: UpdateState;
  overlayVisible: boolean;
  elevated: boolean;
  profile: string | null;
}

/** Кадр для «Отметить глюк»: имя вида 012_-0345ms.jpg и JPEG */
export interface LogFrame {
  name: string;
  data: ArrayBuffer;
}

export interface DuoApi {
  getConfig(): Promise<{ config: Config; path: string; error: string | null }>;
  saveConfig(config: Config): Promise<Config>;
  openConfigFile(): Promise<string>;
  listSources(): Promise<DesktopSource[]>;
  selectSource(source: { id: string; name: string }, audio: boolean): Promise<boolean>;
  getAppInfo(): Promise<AppInfo>;
  getPublicIp(): Promise<string | null>;
  focusWindow(): Promise<void>;
  /** Журнал сеанса (src/main/logger.ts) */
  log(level: LogLevel, text: string): void;
  revealLog(): Promise<string | null>;
  /** PNG (data:) рядом с журналом → имя файла */
  saveLogImage(dataUrl: string): Promise<string | null>;
  /** Кадры отметки глюка → папка и сколько сохранено (null — лимит за сеанс) */
  saveLogFrames(label: string, frames: LogFrame[]): Promise<{ dir: string; saved: number } | null>;
  onMainError(cb: (message: string) => void): void;
  /** Оверлей поверх игры (src/main/overlay.ts) */
  overlay: {
    /** Главное окно: текущее состояние для оверлея */
    update(state: OverlayState): void;
    /** Окно оверлея: состояние от главного окна */
    onState(cb: (state: OverlayState) => void): void;
  };
  /** Чат: приём файлов кусками на диск («Загрузки\DuoStream») и отправка кусками с диска */
  files: {
    create(name: string): Promise<{ id: number; path: string }>;
    write(id: number, offset: number, data: ArrayBuffer): Promise<void>;
    close(id: number): Promise<void>;
    abort(id: number): Promise<void>;
    reveal(file: string): Promise<void>;
    /** Открыть выбранный или перетащенный файл для чтения с диска → id; у файла без пути — ошибка */
    openRead(file: File): Promise<number>;
    /** Меньше length — конец файла */
    read(id: number, offset: number, length: number): Promise<Uint8Array>;
    closeRead(id: number): Promise<void>;
  };
  appAudio: {
    /** Звук приложения окна sourceId */
    start(sourceId: string): Promise<Result<{ session: number }>>;
    stop(session: number): Promise<void>;
    /** Float32Array стерео с чередованием, 48 кГц */
    onData(cb: (session: number, samples: Float32Array) => void): void;
    /** Процесс захвата звука завершился сам */
    onEnded(cb: (session: number, message: string) => void): void;
  };
  upnp: {
    open(tcp: number[], udp: number[]): Promise<UpnpState>;
    close(): Promise<void>;
  };
  update: {
    status(): Promise<UpdateState>;
    /** Перезапуск с новой версией (установленная) или страница загрузки (portable) */
    install(): Promise<void>;
    onState(cb: (state: UpdateState) => void): void;
  };
  hotkeys: {
    record(): Promise<HotkeyRecordResult>;
    cancel(): Promise<void>;
    onAction(cb: (e: { action: HotkeyAction; phase: HotkeyPhase }) => void): void;
  };
  server: {
    start(port: number, password: string, allowedIps: string[]): Promise<Result<{ port: number; lan: string[] }>>;
    stop(): Promise<void>;
  };
  nativeCapture: {
    status(): Promise<NativeCaptureStatus>;
    start(sourceId: string, fps: number): Promise<Result<{ session: number; width: number; height: number; adapter: string }>>;
    stop(session: number): Promise<void>;
    /** imported.getVideoFrame() даёт VideoFrame на GPU */
    onFrame(cb: (imported: ImportedTexture, session: number) => Promise<void> | void): void;
    onEvent(cb: (e: NativeCaptureEvent) => void): void;
  };
}
