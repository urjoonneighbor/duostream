'use strict';
// Загрузка, проверка и сохранение stream.config.json (настройки стрима, звука и сети).
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
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
  },
  // Глобальные горячие клавиши (src/main/hotkeys.js); null — не назначено. Коды — uiohook.
  hotkeys: {
    toggleMute: { key: 50, ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl + Shift + M' },
    toggleDeafen: { key: 32, ctrl: true, shift: true, alt: false, meta: false, label: 'Ctrl + Shift + D' },
    pushToTalk: null,
    toggleDenoise: null,
    toggleStream: null,
  },
  network: {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
    turn: { enabled: false, urls: 'turn:203.0.113.10:3478', username: '', credential: '' },
    udpPortRange: { min: 50000, max: 50019 },
    publicIp: '',
    forceRelay: false,
  },
  playback: {
    jitterBufferTargetMs: 0,
  },
  app: {
    autoUpdate: true, // проверять обновления на GitHub (src/main/updater.js)
  },
});

const KNOWN_CODECS = ['AV1', 'H264', 'VP9', 'VP8'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  const src = isPlainObject(over) ? over : {};
  const out = {};
  for (const key of Object.keys(base)) {
    if (isPlainObject(base[key])) out[key] = deepMerge(base[key], src[key]);
    else out[key] = src[key] !== undefined ? src[key] : structuredClone(base[key]);
  }
  // Неизвестные ключи (например, _help) сохраняем как есть
  for (const key of Object.keys(src)) if (!(key in base)) out[key] = src[key];
  return out;
}

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);
const str = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

function sanitizeIceServers(list) {
  if (!Array.isArray(list)) return structuredClone(DEFAULTS.network.iceServers);
  return list
    .filter((s) => isPlainObject(s) && (typeof s.urls === 'string' || Array.isArray(s.urls)))
    .map((s) => {
      const server = { urls: Array.isArray(s.urls) ? s.urls.filter((u) => typeof u === 'string' && u) : s.urls };
      if (typeof s.username === 'string') server.username = s.username;
      if (typeof s.credential === 'string') server.credential = s.credential;
      return server;
    })
    .filter((s) => s.urls.length > 0);
}

function sanitizeBinding(b) {
  if (!isPlainObject(b)) return null;
  const out = { ctrl: b.ctrl === true, shift: b.shift === true, alt: b.alt === true, meta: b.meta === true };
  if (Number.isInteger(b.mouse) && b.mouse >= 3 && b.mouse <= 8) out.mouse = b.mouse;
  else if (Number.isInteger(b.key) && b.key > 0 && b.key <= 0xffff) out.key = b.key;
  else return null;
  out.label = str(b.label).slice(0, 64) || (out.mouse ? `Мышь ${out.mouse}` : `Клавиша ${out.key}`);
  return out;
}

/** deepMerge не годится: null («не назначено») не должен заменяться привязкой по умолчанию */
function sanitizeHotkeys(input) {
  const src = isPlainObject(input) ? input : {};
  const out = {};
  for (const [action, fallback] of Object.entries(DEFAULTS.hotkeys)) {
    out[action] = action in src ? sanitizeBinding(src[action]) : structuredClone(fallback);
  }
  return out;
}

function sanitize(input) {
  const d = DEFAULTS;
  const c = deepMerge(d, input);
  c.hotkeys = sanitizeHotkeys(isPlainObject(input) ? input.hotkeys : undefined);

  c.signaling.url = str(c.signaling.url, d.signaling.url) || d.signaling.url;
  c.signaling.password = typeof c.signaling.password === 'string' ? c.signaling.password : '';
  c.signaling.role = oneOf(c.signaling.role, ['streamer', 'viewer'], d.signaling.role);
  c.signaling.displayName = str(c.signaling.displayName).slice(0, 64);
  // Стример: запускать сигнальный сервер внутри приложения (отдельный Node.js не нужен)
  c.signaling.hostServer = bool(c.signaling.hostServer, d.signaling.hostServer);
  c.signaling.serverPort = clampInt(c.signaling.serverPort, 1, 65535, d.signaling.serverPort);
  c.signaling.allowedIps = Array.isArray(c.signaling.allowedIps)
    ? [...new Set(c.signaling.allowedIps.map((ip) => str(String(ip))).filter((ip) => /^[0-9a-fA-F.:/]{2,49}$/.test(ip)))].slice(0, 32)
    : [];

  const v = c.video;
  // 0×0 = нативное разрешение источника
  v.width = clampInt(v.width, 0, 7680, d.video.width);
  v.height = clampInt(v.height, 0, 4320, d.video.height);
  // 120 FPS — верхний предел захвата экрана в Chromium (kMaxScreenCastFrameRate)
  v.frameRate = clampInt(v.frameRate, 1, 120, d.video.frameRate);
  v.bitrateKbps = clampInt(v.bitrateKbps, 500, 200000, d.video.bitrateKbps);
  v.minBitrateKbps = clampInt(v.minBitrateKbps, 0, v.bitrateKbps, Math.min(d.video.minBitrateKbps, v.bitrateKbps));
  const codecs = Array.isArray(v.codecs) ? v.codecs.map((x) => String(x).toUpperCase()) : [];
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

  c.playback.jitterBufferTargetMs = clampInt(c.playback.jitterBufferTargetMs, 0, 4000, 0);
  c.app.autoUpdate = bool(c.app.autoUpdate, d.app.autoUpdate);
  return c;
}

function readJson(file) {
  // Блокнот Windows может сохранить файл с BOM
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * @returns {{config: object, error: string|null}}
 */
function loadConfig(file, templateFile) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // read+write, а не copyFile: в собранном приложении шаблон лежит внутри app.asar
    if (templateFile && fs.existsSync(templateFile)) fs.writeFileSync(file, fs.readFileSync(templateFile));
    else writeJsonAtomic(file, DEFAULTS);
  }
  try {
    return { config: sanitize(readJson(file)), error: null };
  } catch (err) {
    return { config: sanitize({}), error: `Не удалось прочитать ${file}: ${err.message}. Используются значения по умолчанию.` };
  }
}

function saveConfig(file, cfg) {
  const clean = sanitize(cfg);
  writeJsonAtomic(file, clean);
  return clean;
}

module.exports = { DEFAULTS, sanitize, loadConfig, saveConfig };
