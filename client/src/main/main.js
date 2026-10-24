'use strict';
/**
 * DuoStream — главный процесс Electron.
 *
 *  - включает флаги Chromium (аппаратный AV1 для WebRTC, без mDNS-маскировки локальных IP);
 *  - фиксирует диапазон UDP-портов WebRTC, чтобы его можно было пробросить на роутере;
 *  - отдаёт интерфейс по собственному протоколу app://local (нужен для module worker и wasm);
 *  - выбирает источник захвата экрана/окна и системный звук (loopback) для getDisplayMedia;
 *  - читает/пишет stream.config.json.
 */
const { app, BrowserWindow, desktopCapturer, ipcMain, protocol, session, shell, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, saveConfig } = require('./config');
const { NativeCapture } = require('./native-capture');
const { EmbeddedServer } = require('./embedded-server');

const APP_ROOT = path.join(__dirname, '..', '..');
const RENDERER_ROOT = path.join(APP_ROOT, 'src', 'renderer');
// Шаблон по умолчанию (попадает в сборку) и рабочий файл при запуске из исходников (не в git)
const CONFIG_TEMPLATE = path.join(APP_ROOT, 'config', 'stream.config.default.json');
const DEV_CONFIG = path.join(APP_ROOT, 'config', 'stream.config.json');
const APP_ORIGIN = 'app://local';

// ---------- аргументы: --profile=<имя> (второй экземпляр на одном ПК), --config=<путь> ----------
function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const profile = argValue('profile');
if (profile) {
  const safe = profile.replace(/[^\w-]/g, '_');
  app.setPath('userData', path.join(app.getPath('appData'), `DuoStream-${safe}`));
}

function resolveConfigPath() {
  const explicit = argValue('config');
  if (explicit) return path.resolve(explicit);
  if (app.isPackaged || profile) return path.join(app.getPath('userData'), 'stream.config.json');
  return DEV_CONFIG; // режим разработки: файл в проекте, создаётся из шаблона при первом запуске
}

// ---------- флаги Chromium (обязательно до app.ready) ----------
// WebRtcAV1HWEncode: на Windows аппаратный AV1 для WebRTC выключен по умолчанию
// (media/webrtc/webrtc_features.cc). Включаем, чтобы использовать AV1-энкодер NVENC
// через Media Foundation (RTX 40xx/50xx).
// (WebRtcAllowWgcUsingTexture — захват в D3D-текстуру без копии в RAM — не включаем: в Chromium 152
// с ним аппаратный энкодер не принимает кадры и WebRTC молча уходит в программный libaom.)
app.commandLine.appendSwitch('enable-features', ['WebRtcAV1HWEncode'].join(','));
// Без mDNS host-кандидаты содержат реальный локальный IP — он нужен для
// синтеза кандидата «белый IP : проброшенный порт» (см. renderer/js/peer.js).
app.commandLine.appendSwitch('disable-features', ['WebRtcHideLocalIpsWithMdns'].join(','));
// Не душить таймеры и рендерер, когда окно свёрнуто, а на переднем плане игра
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// На ПК/ноутбуках с двумя GPU просим дискретную видеокарту
app.commandLine.appendSwitch('force_high_performance_gpu');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

let mainWindow = null;
let configPath = null;
let current = { config: null, error: null };
/** Источник, выбранный в окне выбора экрана, ждёт вызова getDisplayMedia */
let pendingCapture = null;
const nativeCapture = new NativeCapture();
const embeddedServer = new EmbeddedServer();

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'local') return new Response('Not found', { status: 404 });
    const file = path.normalize(path.join(RENDERER_ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(RENDERER_ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        headers: {
          'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function applyNetworkPolicy(webContents) {
  // 'default' — WebRTC может использовать все интерфейсы (нужны host-кандидаты)
  webContents.setWebRTCIPHandlingPolicy('default');
  const { min, max } = current.config.network.udpPortRange;
  webContents.setWebRTCUDPPortRange({ min, max });
}

const isTrustedSender = (event) => Boolean(event.senderFrame?.url?.startsWith(`${APP_ORIGIN}/`));

function setupPermissions() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'speaker-selection', 'fullscreen', 'clipboard-sanitized-write']);

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(Boolean(details.requestingUrl?.startsWith(APP_ORIGIN)) && allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => origin.startsWith(APP_ORIGIN) && allowed.has(permission));

  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      const pick = pendingCapture;
      pendingCapture = null;
      if (!pick || Date.now() - pick.at > 30_000) {
        callback(null);
        return;
      }
      const streams = { video: { id: pick.id, name: pick.name } };
      // Системный звук (loopback) Chromium умеет захватывать только на Windows
      if (pick.audio && request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    },
    { useSystemPicker: false },
  );
}

async function gpuSummary() {
  try {
    // 'complete', а не 'basic': только в полном отчёте отмечено, какой GPU реально используется
    const info = await app.getGPUInfo('complete');
    const vendors = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel', 0x1414: 'Microsoft' };
    const devices = (info.gpuDevice ?? []).map((d) => ({
      vendor: vendors[d.vendorId] ?? `0x${Number(d.vendorId).toString(16)}`,
      deviceId: `0x${Number(d.deviceId).toString(16)}`,
      active: Boolean(d.active),
      description: d.deviceString ?? '',
    }));
    return { devices, renderer: info.auxAttributes?.glRenderer ?? '' };
  } catch (err) {
    return { devices: [], renderer: '', error: err.message };
  }
}

function registerIpc() {
  ipcMain.handle('config:get', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return { config: current.config, path: configPath, error: current.error };
  });

  ipcMain.handle('config:save', (event, cfg) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    current = { config: saveConfig(configPath, cfg), error: null };
    if (mainWindow) applyNetworkPolicy(mainWindow.webContents);
    return current.config;
  });

  ipcMain.handle('config:open', async (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return shell.openPath(configPath);
  });

  ipcMain.handle('capture:list-sources', async (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    const own = mainWindow?.getMediaSourceId();
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 384, height: 216 },
      fetchWindowIcons: true,
    });
    return sources
      .filter((s) => s.id !== own)
      .map((s) => ({
        id: s.id,
        name: s.name,
        type: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? null : `data:image/jpeg;base64,${s.thumbnail.toJPEG(75).toString('base64')}`,
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      }));
  });

  ipcMain.handle('capture:select', (event, pick) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    if (!pick || typeof pick.id !== 'string') throw new Error('bad source');
    pendingCapture = { id: pick.id, name: String(pick.name ?? ''), audio: Boolean(pick.audio), at: Date.now() };
    return true;
  });

  ipcMain.handle('server:start', async (event, request) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    const port = Math.round(Number(request?.port));
    const password = String(request?.password ?? '');
    if (!(port >= 1 && port <= 65535)) return { ok: false, error: 'некорректный порт' };
    try {
      return { ok: true, ...(await embeddedServer.start({ port, password })) };
    } catch (err) {
      return { ok: false, code: err.code ?? null, error: err.message };
    }
  });

  ipcMain.handle('server:stop', async (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    await embeddedServer.stop();
  });

  ipcMain.handle('native-capture:status', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return nativeCapture.status();
  });

  ipcMain.handle('native-capture:start', async (event, request) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    const sourceId = String(request?.sourceId ?? '');
    const fps = Math.min(240, Math.max(1, Math.round(Number(request?.fps) || 60)));
    if (!/^(screen|window):/.test(sourceId) || !mainWindow) return { ok: false, error: 'некорректный источник' };
    const webContents = mainWindow.webContents;
    try {
      const result = await nativeCapture.start({
        sourceId,
        fps,
        webContents,
        onEvent: (e) => {
          if (!webContents.isDestroyed()) webContents.send('native-capture:event', e);
        },
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('native-capture:stop', (event, session) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    nativeCapture.stop(Number.isInteger(session) ? session : undefined);
  });

  ipcMain.handle('app:info', async (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return {
      versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome },
      platform: process.platform,
      gpu: await gpuSummary(),
      gpuFeatures: app.getGPUFeatureStatus(),
      udpPortRange: mainWindow?.webContents.getWebRTCUDPPortRange(),
      nativeCapture: nativeCapture.status(),
      profile: profile ?? null,
    };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: profile ? `DuoStream (${profile})` : 'DuoStream',
    backgroundColor: '#0d0f13',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });

  applyNetworkPolicy(mainWindow.webContents);

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });
  // F12 / Ctrl+Shift+I — инструменты разработчика (chrome://webrtc-internals недоступен, а консоль полезна)
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    const devtools = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (input.type === 'keyDown' && devtools) mainWindow.webContents.toggleDevTools();
  });
  mainWindow.on('closed', () => {
    nativeCapture.stop();
    mainWindow = null;
  });
  // Перезагрузка страницы (F5 в DevTools) — старый захват больше некому принимать
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) nativeCapture.stop();
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

app.whenReady().then(() => {
  configPath = resolveConfigPath();
  current = loadConfig(configPath, CONFIG_TEMPLATE);
  if (current.error) console.error(current.error);

  Menu.setApplicationMenu(null);
  registerAppProtocol();
  setupPermissions();
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  nativeCapture.stop();
  embeddedServer.stop();
});
