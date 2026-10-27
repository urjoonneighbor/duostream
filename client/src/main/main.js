'use strict';
/**
 * DuoStream — главный процесс Electron.
 *
 *  - включает флаги Chromium (аппаратный AV1 для WebRTC, без mDNS-маскировки локальных IP);
 *  - фиксирует диапазон UDP-портов WebRTC, чтобы его можно было пробросить на роутере;
 *  - отдаёт интерфейс по собственному протоколу app://local (нужен для module worker и wasm);
 *  - выбирает источник захвата экрана/окна и системный звук (loopback) для getDisplayMedia;
 *  - читает/пишет stream.config.json;
 *  - глобальные горячие клавиши (src/main/hotkeys.js) пересылает интерфейсу;
 *  - обновляется из GitHub Releases (src/main/updater.js);
 *  - открывает порты стримера на роутере через UPnP (src/main/upnp.js).
 */
const { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, session, shell, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, saveConfig } = require('./config');
const { NativeCapture } = require('./native-capture');
const { EmbeddedServer } = require('./embedded-server');
const { Hotkeys } = require('./hotkeys');
const { Updater } = require('./updater');
const { PortMapper } = require('./upnp');
const { AppAudioCapture } = require('./app-audio');
const { log } = require('./logger');
const { Downloads, Uploads } = require('./downloads');
const { Overlay } = require('./overlay');
const { AppTray } = require('./tray');
const os = require('node:os');

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
} else if (!app.isPackaged) {
  // Запуск из исходников не делит папку данных с установленным DuoStream.exe
  app.setPath('userData', path.join(app.getPath('appData'), 'DuoStream-dev'));
}

// Один экземпляр на папку данных: второй делил бы кэш Chromium (ошибки «Unable to move the cache»)
// и порт сервера. Повторный запуск просто показывает уже открытое окно. Для второго окна на одном
// ПК (проверка «стример + зритель») — запуск с --profile=<имя>.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => tray.show());
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
// Без DirectComposition — значит, без аппаратных видеооверлеев (MPO). На части ПК с NVIDIA видео в оверлее
// мигает кадрами без яркости (чёрный фон и цветные пятна), причём на скриншоте глюка нет: при захвате
// экрана Windows перестаёт использовать оверлей. Сами кадры целые — это сбой вывода. Отдельного флага
// только для видеооверлеев в Chromium 152 нет, поэтому выключаем DirectComposition целиком.
app.commandLine.appendSwitch('disable-direct-composition');
// Способ вывода видео (ниже) действует только с запуска, поэтому настройки читаются здесь, до app.ready.
const startupConfig = (() => {
  try {
    return loadConfig(resolveConfigPath(), CONFIG_TEMPLATE).config;
  } catch {
    return null;
  }
})();
// «Вывод видео у зрителя» (Видео): если картинка портится только на экране, а кадры целые («Отметить глюк»),
// виноват путь вывода через видеокарту. Chromium рисует через ANGLE; по умолчанию это Direct3D 11,
// можно выбрать OpenGL (окно рисует видеокарта, видео декодирует процессор — аппаратный декодер Chromium
// работает только с D3D11) или Vulkan (в Chromium 152 на Windows окно рисует процессор), либо совсем без
// видеокарты. Только у зрителя: стримеру нужен D3D11 — захват
// отдаёт кадры текстурами D3D11, кодирует их видеокарта.
const renderer = startupConfig?.signaling.role === 'viewer' ? startupConfig.video.renderer : 'd3d11';
if (renderer === 'software') app.disableHardwareAcceleration();
else if (renderer === 'opengl') app.commandLine.appendSwitch('use-angle', 'gl');
else if (renderer === 'vulkan') app.commandLine.appendSwitch('use-angle', 'vulkan');

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
const sendToWindow = (channel, payload) => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
const hotkeys = new Hotkeys((action, phase) => sendToWindow('hotkey', { action, phase }));
const updater = new Updater((state) => sendToWindow('update', state));
const portMapper = new PortMapper((state) => sendToWindow('upnp', state));
const appAudio = new AppAudioCapture();
const downloads = new Downloads(() => path.join(app.getPath('downloads'), 'DuoStream'));
const uploads = new Uploads();
const tray = new AppTray({ icon: path.join(RENDERER_ROOT, 'img', 'icon-256.png'), onQuit: () => app.quit() });
const overlay = new Overlay({ preload: path.join(__dirname, '..', 'preload', 'preload.js'), url: `${APP_ORIGIN}/overlay.html` });

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

/**
 * Запущено ли с правами администратора (высокий уровень целостности, SID S-1-16-12288). Тогда Windows (UIPI)
 * не даёт перетаскивать файлы из обычного Проводника — у пользователя «не работает drag-n-drop».
 */
let isElevated = false;
function checkElevated() {
  return new Promise((resolve) => {
    require('node:child_process').execFile('whoami', ['/groups'], { windowsHide: true, timeout: 5000 }, (err, stdout) =>
      resolve(!err && String(stdout).includes('S-1-16-12288')),
    );
  });
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
    hotkeys.update(current.config.hotkeys);
    updater.configure(current.config.app.autoUpdate);
    return current.config;
  });

  // Журнал: строки от интерфейса и показ файла в проводнике
  ipcMain.on('log:write', (event, level, text) => {
    if (!isTrustedSender(event)) return;
    log.write(['info', 'warn', 'error'].includes(level) ? level : 'info', 'ui', String(text).slice(0, 20_000));
  });

  // Картинка кадра-выброса у зрителя (js/glitch.js) — рядом с файлом журнала
  let glitchImages = 0;
  ipcMain.handle('log:image', (event, dataUrl) => {
    if (!isTrustedSender(event) || !log.file || glitchImages >= 50) return null;
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m) return null;
    const file = log.imagePath(++glitchImages);
    fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
    return path.basename(file);
  });

  // «Отметить глюк»: последние кадры видео (src/renderer/js/frame-recorder.js) — в папку рядом с журналом
  let markedGlitches = 0;
  ipcMain.handle('log:frames', async (event, label, frames) => {
    if (!isTrustedSender(event) || !log.dir || markedGlitches >= 20 || !Array.isArray(frames)) return null;
    const dir = log.framesDir(String(label).replace(/[^\w-]/g, '').slice(0, 20) || 'frames');
    await fs.promises.mkdir(dir, { recursive: true });
    markedGlitches++;
    let saved = 0;
    for (const f of frames.slice(0, 200)) {
      if (!/^\d{3}_-\d{4,5}ms\.jpg$/.test(String(f?.name)) || !(f.data instanceof ArrayBuffer || ArrayBuffer.isView(f.data))) continue;
      await fs.promises.writeFile(path.join(dir, f.name), Buffer.from(f.data));
      saved++;
    }
    return { dir: path.basename(dir), saved };
  });

  ipcMain.handle('log:reveal', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    const file = log.ensureFile();
    if (file) shell.showItemInFolder(file);
    return file;
  });

  // Оверлей поверх игры (src/main/overlay.js): состояние приходит из главного окна ~10 раз в секунду
  ipcMain.on('overlay:update', (event, state) => {
    if (!isTrustedSender(event) || event.sender !== mainWindow?.webContents) return;
    overlay.update(state && typeof state === 'object' ? state : {});
  });

  // Приём файлов из чата (src/main/downloads.js)
  ipcMain.handle('file:create', (event, name) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return downloads.create(name);
  });
  ipcMain.handle('file:write', (event, id, offset, data) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return downloads.write(Number(id), Number(offset), data);
  });
  ipcMain.handle('file:close', (event, id) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return downloads.close(Number(id));
  });
  ipcMain.handle('file:abort', (event, id) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return downloads.abort(Number(id));
  });
  // Отправка файлов из чата: чтение кусками (src/main/downloads.js, Uploads)
  ipcMain.handle('upload:open', (event, file) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return uploads.open(file);
  });
  ipcMain.handle('upload:read', (event, id, offset, length) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return uploads.read(Number(id), Number(offset), Number(length));
  });
  ipcMain.handle('upload:close', (event, id) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return uploads.close(Number(id));
  });
  ipcMain.handle('file:reveal', (event, file) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    // Показываем только файлы из папки загрузок DuoStream
    const dir = path.join(app.getPath('downloads'), 'DuoStream');
    const target = path.resolve(String(file ?? ''));
    if (target.startsWith(dir + path.sep)) shell.showItemInFolder(target);
  });

  // Звук только приложения транслируемого окна (src/main/app-audio.js)
  ipcMain.handle('app-audio:start', async (event, sourceId) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    if (!mainWindow) return { ok: false, error: 'нет окна' };
    try {
      return { ok: true, ...(await appAudio.start({ sourceId: String(sourceId ?? ''), webContents: mainWindow.webContents })) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app-audio:stop', (event, session) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    appAudio.stop(Number.isInteger(session) ? session : undefined);
  });

  // Проброс портов на роутере через UPnP, пока стример подключён
  ipcMain.handle('upnp:open', (event, request) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    const ports = (list) => (Array.isArray(list) ? list.map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 64) : []);
    return portMapper.open({ tcp: ports(request?.tcp), udp: ports(request?.udp) });
  });

  ipcMain.handle('upnp:close', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return portMapper.close();
  });

  ipcMain.handle('update:status', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return updater.status();
  });

  ipcMain.handle('update:install', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    updater.install();
  });

  // Назначение горячей клавиши: следующее нажатие (в любом окне) становится привязкой
  ipcMain.handle('hotkeys:record', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return hotkeys.record();
  });

  ipcMain.handle('hotkeys:cancel', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    hotkeys.cancelRecord();
  });

  // Горячая клавиша трансляции: показать окно, чтобы выбрать экран
  ipcMain.handle('app:focus', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
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
    const allowedIps = Array.isArray(request?.allowedIps) ? request.allowedIps.map(String) : [];
    if (!(port >= 1 && port <= 65535)) return { ok: false, error: 'некорректный порт' };
    try {
      return { ok: true, ...(await embeddedServer.start({ port, password, allowedIps })) };
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

  // Внешний IP так, как его видят TCP-подключения из интернета (тем же путём зритель идёт
  // к сигнальному серверу). STUN бывает не годится: провайдер или роутер может уводить UDP
  // к серверам Google через другой адрес, и тогда srflx-кандидат указывает не на ваш роутер.
  ipcMain.handle('net:public-ip', async (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    try {
      const response = await net.fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
      const ip = (await response.text()).trim();
      return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
    } catch {
      return null;
    }
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
      hotkeys: hotkeys.status(),
      update: updater.status(),
      overlayVisible: overlay.visible,
      elevated: isElevated,
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
    // В собранном exe иконка и так вшита; при запуске из исходников без этого была бы иконка Electron
    icon: path.join(RENDERER_ROOT, 'img', 'icon-256.png'),
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Статус GPU-функций честный только после запуска GPU-процесса: сразу после старта всё «disabled_software»
    setTimeout(() => log.info('main', 'GPU-функции', app.getGPUFeatureStatus()), 3000);
  });
  overlay.attachMainWindow(mainWindow);
  tray.attach(mainWindow);
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
    appAudio.stop();
    mainWindow = null;
  });
  // Перезагрузка страницы (F5 в DevTools) — старый захват больше некому принимать
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      nativeCapture.stop();
      appAudio.stop();
    }
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

/** Настройки для журнала: без паролей */
function configForLog(cfg) {
  const copy = structuredClone(cfg);
  copy.signaling.password = copy.signaling.password ? '***' : '';
  copy.network.turn.credential = copy.network.turn.credential ? '***' : '';
  return copy;
}

app.whenReady().then(() => {
  if (!singleInstance) return;
  log.open(path.join(app.getPath('userData'), 'logs'));
  log.captureConsole();
  configPath = resolveConfigPath();
  current = loadConfig(configPath, CONFIG_TEMPLATE);
  if (current.error) console.error(current.error);
  log.info(
    'main',
    `DuoStream ${app.getVersion()} (${app.isPackaged ? 'сборка' : 'исходники'}${profile ? `, профиль ${profile}` : ''}), ` +
      `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Windows ${os.release()}`,
  );
  log.info('main', 'настройки', configForLog(current.config));
  gpuSummary().then((gpu) => log.info('main', 'видеокарты', gpu));
  // Чем именно выводится видео (по этому видно, в какой сборке зритель и что включено)
  log.info('main', 'запуск', {
    exeBuilt: fs.statSync(process.execPath).mtime.toISOString(),
    renderer,
    switches: process.argv.slice(1).concat(
      ['disable-direct-composition', 'disable-accelerated-video-decode'].filter((sw) => app.commandLine.hasSwitch(sw)).map((sw) => `--${sw}`),
    ),
  });
  checkElevated().then((elevated) => {
    isElevated = elevated;
    if (elevated) log.warn('main', 'запущено от имени администратора: перетаскивание файлов из Проводника не работает (UIPI)');
  });

  Menu.setApplicationMenu(null);
  registerAppProtocol();
  setupPermissions();
  registerIpc();
  tray.create();
  createWindow();
  try {
    hotkeys.update(current.config.hotkeys);
  } catch (err) {
    console.error('[hotkeys]', err);
  }
  // Проверка обновлений — когда окно уже загрузилось и может показать уведомление
  mainWindow.webContents.once('did-finish-load', () => updater.configure(current.config.app.autoUpdate));
});

// Сбои — в журнал; необработанное исключение главного процесса ещё и показываем в окне вместо падения
process.on('uncaughtException', (err) => {
  log.error('main', 'необработанное исключение:', err?.stack ?? err);
  sendToWindow('main-error', String(err?.message ?? err));
});
process.on('unhandledRejection', (reason) => log.error('main', 'необработанный отказ промиса:', reason?.stack ?? reason));
app.on('child-process-gone', (_event, details) => log.warn('main', 'процесс Chromium завершился:', details));
app.on('render-process-gone', (_event, _wc, details) => log.error('main', 'процесс окна упал:', details));

app.on('window-all-closed', () => app.quit());
let portsClosed = false;
app.on('before-quit', (event) => {
  tray.quitting = true; // дальше крестик окна закрывает его, а не прячет в трей
  hotkeys.stop();
  nativeCapture.stop();
  appAudio.stop();
  embeddedServer.stop();
  downloads.closeAll(); // недокачанные файлы удаляем
  uploads.closeAll();
  // Порты на роутере закрываем до выхода (не дольше 3 с); если не успели — их закроет истечение аренды
  if (!portsClosed && portMapper.mappings.length) {
    event.preventDefault();
    portsClosed = true;
    Promise.race([portMapper.close(), new Promise((resolve) => setTimeout(resolve, 3000))]).finally(() => app.quit());
    return;
  }
  log.info('main', 'выход');
});
app.on('quit', () => {
  tray.destroy();
  log.close();
});
