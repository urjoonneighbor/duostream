// Загрузка, проверка и сохранение stream.config.json (настройки стрима, звука и сети).
import fs from 'node:fs';
import path from 'node:path';
import type { Config, HotkeyAction, HotkeyBinding, IceServerConfig } from '../shared/config';

export const DEFAULTS: Readonly<Config> = Object.freeze<Config>({
  signaling: {
    url: 'ws://127.0.0.1:8787',
    password: '',
    role: 'streamer',
    displayName: '',
    hostServer: true,
    serverPort: 8787,
    allowedIps: [], // встроенный сервер: кому можно подключаться (IP или подсеть IPv4 a.b.c.d/n); пусто — всем
  },
  video: {
    width: 2560,
    height: 1440,
    frameRate: 120,
    bitrateKbps: 20000,
    minBitrateKbps: 8000,
    codecs: ['AV1', 'H264', 'VP9'],
    preferHardware: true,
    contentHint: 'motion',
    degradationPreference: 'maintain-framerate',
    showPreview: true,
    captureEngine: 'auto',
    // Вывод видео у зрителя (main.ts, до app.ready): d3d11 — по умолчанию; opengl, vulkan — другой путь
    // ANGLE через видеокарту; software — без видеокарты. У стримера всегда d3d11 (захват и кодирование)
    renderer: 'd3d11',
  },
  audio: {
    micDeviceId: 'default',
    outputDeviceId: 'default',
    noiseSuppression: true,
    denoiseModel: 'dfn3',
    denoiseLimitDb: 0,
    voiceGate: true,
    echoCancellation: true,
    autoGainControl: true,
    voiceBitrateKbps: 64,
    captureSystemAudio: false,
    systemAudioBitrateKbps: 160,
    pushToTalk: false,
    pushToTalkReleaseMs: 150,
    uiSounds: true, // звуки событий: собеседник подключился/отключился, трансляция началась/закончилась
  },
  // Глобальные горячие клавиши (src/main/hotkeys.ts); null — не назначено. Коды — uiohook.
  hotkeys: {
    toggleMute: { key: 50, ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl + Shift + M' },
    toggleDeafen: { key: 32, ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl + Shift + D' },
    pushToTalk: null,
    toggleDenoise: null,
    toggleStream: null,
    // «Отметить глюк»: сохранить последние ~2 с кадров у обоих (src/renderer/js/frame-recorder.ts)
    markGlitch: { key: 34, ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl + Shift + G' },
  },
  network: {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
    turn: { enabled: false, urls: 'turn:203.0.113.10:3478', username: '', credential: '' },
    udpPortRange: { min: 50000, max: 50019 },
    publicIp: '',
    forceRelay: false,
    upnp: true, // стример: открывать порты на роутере автоматически (src/main/upnp.ts)
  },
  playback: {
    // Запас буфера трансляции у зрителя (видео и звук трансляции поровну — синхронность сохраняется), мс.
    // Без запаса звук трансляции трещит: пакеты звука застревают за пачками видео (1440p, десятки Мбит/с),
    // опаздывают, и приёмник их досочиняет. Голос не задерживается — разговор без лишней паузы.
    streamBufferMs: 120,
  },
  app: {
    autoUpdate: true, // проверять обновления на GitHub (src/main/updater.ts)
    overlay: { enabled: true, corner: 'top-left' }, // оверлей поверх игры (src/main/overlay.ts)
  },
});

const KNOWN_CODECS = ['AV1', 'H264', 'VP9', 'VP8'];

/** Разбираемый JSON: что угодно, проверяется по полям */
type Json = Record<string, any>;

const isPlainObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base: Json, over: unknown): Json {
  const src: Json = isPlainObject(over) ? over : {};
  const out: Json = {};
  for (const key of Object.keys(base)) {
    if (isPlainObject(base[key])) out[key] = deepMerge(base[key], src[key]);
    else out[key] = src[key] !== undefined ? src[key] : structuredClone(base[key]);
  }
  // Неизвестные ключи (например, _help) сохраняем как есть
  for (const key of Object.keys(src)) if (!(key in base)) out[key] = src[key];
  return out;
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const oneOf = <T extends string>(value: unknown, list: readonly T[], fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value.trim() : fallback);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

function sanitizeIceServers(list: unknown): IceServerConfig[] {
  if (!Array.isArray(list)) return structuredClone(DEFAULTS.network.iceServers);
  return list
    .filter((s): s is Json => isPlainObject(s) && (typeof s.urls === 'string' || Array.isArray(s.urls)))
    .map((s) => {
      const server: IceServerConfig = {
        urls: Array.isArray(s.urls) ? s.urls.filter((u: unknown): u is string => typeof u === 'string' && u !== '') : s.urls,
      };
      if (typeof s.username === 'string') server.username = s.username;
      if (typeof s.credential === 'string') server.credential = s.credential;
      return server;
    })
    .filter((s) => s.urls.length > 0);
}

function sanitizeBinding(b: unknown): HotkeyBinding | null {
  if (!isPlainObject(b)) return null;
  const out: HotkeyBinding = { ctrl: b.ctrl === true, shift: b.shift === true, alt: b.alt === true, meta: b.meta === true, label: '' };
  if (Number.isInteger(b.mouse) && b.mouse >= 3 && b.mouse <= 8) out.mouse = b.mouse;
  else if (Number.isInteger(b.key) && b.key > 0 && b.key <= 0xffff) out.key = b.key;
  else return null;
  out.label = str(b.label).slice(0, 64) || (out.mouse ? `Мышь ${out.mouse}` : `Клавиша ${out.key}`);
  return out;
}

/** deepMerge не годится: null («не назначено») не должен заменяться привязкой по умолчанию */
function sanitizeHotkeys(input: unknown): Config['hotkeys'] {
  const src: Json = isPlainObject(input) ? input : {};
  const out = {} as Config['hotkeys'];
  for (const [action, fallback] of Object.entries(DEFAULTS.hotkeys) as [HotkeyAction, HotkeyBinding | null][]) {
    out[action] = action in src ? sanitizeBinding(src[action]) : structuredClone(fallback);
  }
  return out;
}

export function sanitize(input: unknown): Config {
  const d = DEFAULTS;
  const c = deepMerge(d, input);
  const raw: Json = isPlainObject(input) ? input : {};
  c.hotkeys = sanitizeHotkeys(raw.hotkeys);

  c.signaling.url = str(c.signaling.url, d.signaling.url) || d.signaling.url;
  c.signaling.password = typeof c.signaling.password === 'string' ? c.signaling.password : '';
  c.signaling.role = oneOf(c.signaling.role, ['streamer', 'viewer'], d.signaling.role);
  c.signaling.displayName = str(c.signaling.displayName).slice(0, 64);
  // Стример: запускать сигнальный сервер внутри приложения (отдельный Node.js не нужен)
  c.signaling.hostServer = bool(c.signaling.hostServer, d.signaling.hostServer);
  c.signaling.serverPort = clampInt(c.signaling.serverPort, 1, 65535, d.signaling.serverPort);
  c.signaling.allowedIps = Array.isArray(c.signaling.allowedIps)
    ? [
        ...new Set(
          c.signaling.allowedIps.map((ip: unknown) => str(String(ip))).filter((ip: string) => /^[0-9a-fA-F.:/]{2,49}$/.test(ip)),
        ),
      ].slice(0, 32)
    : [];

  const v = c.video;
  // 0×0 = нативное разрешение источника
  v.width = clampInt(v.width, 0, 7680, d.video.width);
  v.height = clampInt(v.height, 0, 4320, d.video.height);
  // 120 FPS — верхний предел захвата экрана в Chromium (kMaxScreenCastFrameRate)
  v.frameRate = clampInt(v.frameRate, 1, 120, d.video.frameRate);
  v.bitrateKbps = clampInt(v.bitrateKbps, 500, 200000, d.video.bitrateKbps);
  v.minBitrateKbps = clampInt(v.minBitrateKbps, 0, v.bitrateKbps, Math.min(d.video.minBitrateKbps, v.bitrateKbps));
  const codecs: string[] = Array.isArray(v.codecs) ? v.codecs.map((x: unknown) => String(x).toUpperCase()) : [];
  v.codecs = [...new Set(codecs.filter((x) => KNOWN_CODECS.includes(x)))];
  if (!v.codecs.length) v.codecs = [...d.video.codecs];
  v.preferHardware = bool(v.preferHardware, d.video.preferHardware);
  v.contentHint = oneOf(v.contentHint, ['motion', 'detail', 'text'], d.video.contentHint);
  v.degradationPreference = oneOf(
    v.degradationPreference,
    ['maintain-framerate', 'maintain-resolution', 'balanced'],
    d.video.degradationPreference,
  );
  v.showPreview = bool(v.showPreview, d.video.showPreview);
  // auto — собственный захват (до 120 FPS), при сбое Chromium; chromium — только getDisplayMedia
  v.captureEngine = oneOf(v.captureEngine, ['auto', 'chromium'], d.video.captureEngine);
  // Прежняя галочка «Аппаратное декодирование» убрана: декодер не был причиной глюков, а видео на процессоре
  // декодируется и так при выводе через OpenGL, Vulkan и без видеокарты (renderer)
  delete v.hardwareDecode;
  // Прежняя галочка «Отрисовка без видеокарты» (video.softwareRendering) — это renderer: 'software'
  const src: Json = isPlainObject(raw.video) ? raw.video : {};
  if (src.softwareRendering === true && src.renderer === undefined) v.renderer = 'software';
  delete v.softwareRendering;
  v.renderer = oneOf(v.renderer, ['d3d11', 'opengl', 'vulkan', 'software'], d.video.renderer);

  const a = c.audio;
  a.micDeviceId = str(a.micDeviceId, 'default') || 'default';
  a.outputDeviceId = str(a.outputDeviceId, 'default') || 'default';
  a.noiseSuppression = bool(a.noiseSuppression, d.audio.noiseSuppression);
  a.denoiseModel = oneOf(a.denoiseModel, ['dfn3', 'dtln'], d.audio.denoiseModel);
  a.denoiseLimitDb = clampInt(a.denoiseLimitDb, 0, 100, d.audio.denoiseLimitDb);
  a.voiceGate = bool(a.voiceGate, d.audio.voiceGate);
  a.echoCancellation = bool(a.echoCancellation, d.audio.echoCancellation);
  a.autoGainControl = bool(a.autoGainControl, d.audio.autoGainControl);
  a.voiceBitrateKbps = clampInt(a.voiceBitrateKbps, 16, 256, d.audio.voiceBitrateKbps);
  a.captureSystemAudio = bool(a.captureSystemAudio, d.audio.captureSystemAudio);
  a.systemAudioBitrateKbps = clampInt(a.systemAudioBitrateKbps, 32, 510, d.audio.systemAudioBitrateKbps);
  // Режим рации: микрофон передаётся, только пока зажата клавиша hotkeys.pushToTalk
  a.pushToTalk = bool(a.pushToTalk, d.audio.pushToTalk);
  a.pushToTalkReleaseMs = clampInt(a.pushToTalkReleaseMs, 0, 2000, d.audio.pushToTalkReleaseMs);
  a.uiSounds = bool(a.uiSounds, d.audio.uiSounds);

  const n = c.network;
  n.iceServers = sanitizeIceServers(n.iceServers);
  n.turn = {
    enabled: bool(n.turn.enabled, false),
    urls: str(n.turn.urls, d.network.turn.urls),
    username: str(n.turn.username),
    credential: typeof n.turn.credential === 'string' ? n.turn.credential : '',
  };
  let min = clampInt(n.udpPortRange.min, 0, 65535, 0);
  let max = clampInt(n.udpPortRange.max, 0, 65535, 0);
  if (min === 0 || max === 0 || min > max) min = max = 0; // 0..0 = без ограничений
  n.udpPortRange = { min, max };
  n.publicIp = str(n.publicIp);
  n.forceRelay = bool(n.forceRelay, false);
  n.upnp = bool(n.upnp, d.network.upnp);

  // Прежняя настройка «джиттер-буфер видео» (playback.jitterBufferTargetMs, 0 — авто): ненулевое значение переносим
  const playback: Json = isPlainObject(raw.playback) ? raw.playback : {};
  const oldBuffer = Number(playback.jitterBufferTargetMs);
  if (playback.streamBufferMs === undefined && oldBuffer > 0) c.playback.streamBufferMs = oldBuffer;
  delete c.playback.jitterBufferTargetMs;
  c.playback.streamBufferMs = clampInt(c.playback.streamBufferMs, 0, 2000, d.playback.streamBufferMs);
  c.app.autoUpdate = bool(c.app.autoUpdate, d.app.autoUpdate);
  c.app.overlay = {
    enabled: bool(c.app.overlay.enabled, d.app.overlay.enabled),
    corner: oneOf(c.app.overlay.corner, ['top-left', 'top-right', 'bottom-left', 'bottom-right'], d.app.overlay.corner),
  };
  return c as Config;
}

function readJson(file: string): unknown {
  // Блокнот Windows может сохранить файл с BOM
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function loadConfig(file: string, templateFile?: string): { config: Config; error: string | null } {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // read+write, а не copyFile: в собранном приложении шаблон лежит внутри app.asar
    if (templateFile && fs.existsSync(templateFile)) fs.writeFileSync(file, fs.readFileSync(templateFile));
    else writeJsonAtomic(file, DEFAULTS);
  }
  try {
    return { config: sanitize(readJson(file)), error: null };
  } catch (err) {
    return { config: sanitize({}), error: `Не удалось прочитать ${file}: ${(err as Error).message}. Используются значения по умолчанию.` };
  }
}

export function saveConfig(file: string, cfg: unknown): Config {
  const clean = sanitize(cfg);
  writeJsonAtomic(file, clean);
  return clean;
}
