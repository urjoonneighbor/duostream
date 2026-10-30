// Настройки stream.config.json (src/main/config.ts) — общие для главного процесса и интерфейса.

export type Role = 'streamer' | 'viewer';
export type CodecName = 'AV1' | 'H264' | 'VP9' | 'VP8';
export type ContentHint = 'motion' | 'detail' | 'text';
export type DegradationPreference = 'maintain-framerate' | 'maintain-resolution' | 'balanced';
export type CaptureEngine = 'auto' | 'chromium';
/** Вывод видео у зрителя: путь ANGLE через видеокарту или без неё */
export type Renderer = 'd3d11' | 'opengl' | 'vulkan' | 'software';
export type DenoiseModel = 'dfn3' | 'dtln';
export type OverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type HotkeyAction = 'toggleMute' | 'toggleDeafen' | 'pushToTalk' | 'toggleDenoise' | 'toggleStream' | 'markGlitch';

/** Клавиша (код uiohook) или кнопка мыши (3–8) с модификаторами */
export interface HotkeyBinding {
  key?: number;
  mouse?: number;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  label: string;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface Config {
  signaling: {
    url: string;
    password: string;
    role: Role;
    displayName: string;
    hostServer: boolean;
    serverPort: number;
    /** Встроенный сервер: кому можно подключаться (IP или подсеть IPv4 a.b.c.d/n); пусто — всем */
    allowedIps: string[];
  };
  video: {
    width: number;
    height: number;
    frameRate: number;
    bitrateKbps: number;
    minBitrateKbps: number;
    codecs: CodecName[];
    preferHardware: boolean;
    contentHint: ContentHint;
    degradationPreference: DegradationPreference;
    showPreview: boolean;
    captureEngine: CaptureEngine;
    renderer: Renderer;
  };
  audio: {
    micDeviceId: string;
    outputDeviceId: string;
    noiseSuppression: boolean;
    denoiseModel: DenoiseModel;
    denoiseLimitDb: number;
    voiceGate: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
    voiceBitrateKbps: number;
    captureSystemAudio: boolean;
    systemAudioBitrateKbps: number;
    pushToTalk: boolean;
    pushToTalkReleaseMs: number;
    uiSounds: boolean;
  };
  hotkeys: Record<HotkeyAction, HotkeyBinding | null>;
  network: {
    iceServers: IceServerConfig[];
    turn: { enabled: boolean; urls: string; username: string; credential: string };
    udpPortRange: { min: number; max: number };
    publicIp: string;
    forceRelay: boolean;
    upnp: boolean;
  };
  playback: {
    streamBufferMs: number;
  };
  app: {
    autoUpdate: boolean;
    overlay: { enabled: boolean; corner: OverlayCorner };
  };
}
