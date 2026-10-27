'use strict';
// Минимальный мост между интерфейсом (sandbox) и главным процессом.
const { contextBridge, ipcRenderer, sharedTexture, webUtils } = require('electron');

// Кадры собственного захвата (см. src/main/native-capture.js). Получатель регистрируется сразу:
// main не может отправить текстуру, пока его нет.
let frameHandler = null;
if (typeof sharedTexture?.setSharedTextureReceiver === 'function') {
  sharedTexture.setSharedTextureReceiver(async (data, session) => {
    const imported = data.importedSharedTexture;
    try {
      if (frameHandler) await frameHandler(imported, session);
    } finally {
      // Текстура вернётся процессу захвата, когда её отпустят и WebRTC, и мы
      imported.release();
    }
  });
}

contextBridge.exposeInMainWorld('duo', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  openConfigFile: () => ipcRenderer.invoke('config:open'),
  listSources: () => ipcRenderer.invoke('capture:list-sources'),
  selectSource: (source, audio) => ipcRenderer.invoke('capture:select', { id: source.id, name: source.name, audio }),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getPublicIp: () => ipcRenderer.invoke('net:public-ip'),
  focusWindow: () => ipcRenderer.invoke('app:focus'),
  /** Журнал сеанса (src/main/logger.js) */
  log: (level, text) => ipcRenderer.send('log:write', level, text),
  revealLog: () => ipcRenderer.invoke('log:reveal'),
  /** PNG (data:) рядом с журналом → имя файла */
  saveLogImage: (dataUrl) => ipcRenderer.invoke('log:image', dataUrl),
  /** Кадры отметки глюка [{name, data: ArrayBuffer}] → {dir, saved} */
  saveLogFrames: (label, frames) => ipcRenderer.invoke('log:frames', label, frames),
  onMainError: (cb) => {
    ipcRenderer.removeAllListeners('main-error');
    ipcRenderer.on('main-error', (_event, message) => cb(message));
  },
  /** Оверлей поверх игры (src/main/overlay.js) */
  overlay: {
    /** Главное окно: текущее состояние для оверлея */
    update: (state) => ipcRenderer.send('overlay:update', state),
    /** Окно оверлея: cb(state) */
    onState: (cb) => {
      ipcRenderer.removeAllListeners('overlay:state');
      ipcRenderer.on('overlay:state', (_event, state) => cb(state));
    },
  },
  /** Приём файлов из чата: запись кусками на диск («Загрузки\DuoStream») */
  files: {
    create: (name) => ipcRenderer.invoke('file:create', name),
    write: (id, offset, data) => ipcRenderer.invoke('file:write', id, offset, data),
    close: (id) => ipcRenderer.invoke('file:close', id),
    abort: (id) => ipcRenderer.invoke('file:abort', id),
    reveal: (file) => ipcRenderer.invoke('file:reveal', file),
    /** Отправка: открыть выбранный или перетащенный файл (File) для чтения с диска → id; без пути — ошибка */
    openRead: (file) => {
      const filePath = webUtils?.getPathForFile(file);
      if (!filePath) return Promise.reject(new Error('у файла нет пути на диске'));
      return ipcRenderer.invoke('upload:open', filePath);
    },
    /** → Uint8Array (меньше length — конец файла) */
    read: (id, offset, length) => ipcRenderer.invoke('upload:read', id, offset, length),
    closeRead: (id) => ipcRenderer.invoke('upload:close', id),
  },
  appAudio: {
    /** Звук приложения окна sourceId → {ok, session} | {ok:false, error} */
    start: (sourceId) => ipcRenderer.invoke('app-audio:start', sourceId),
    stop: (session) => ipcRenderer.invoke('app-audio:stop', session),
    /** cb(session, Float32Array стерео с чередованием, 48 кГц) */
    onData: (cb) => {
      ipcRenderer.removeAllListeners('app-audio:data');
      ipcRenderer.on('app-audio:data', (_event, session, samples) => cb(session, samples));
    },
    /** cb(session, причина) — процесс захвата звука завершился сам */
    onEnded: (cb) => {
      ipcRenderer.removeAllListeners('app-audio:ended');
      ipcRenderer.on('app-audio:ended', (_event, session, message) => cb(session, message));
    },
  },
  upnp: {
    /** → {status:'ok'|'partial'|'unavailable', externalIp, cgnat, router, opened, manual, message} */
    open: (tcp, udp) => ipcRenderer.invoke('upnp:open', { tcp, udp }),
    close: () => ipcRenderer.invoke('upnp:close'),
  },
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    /** Перезапуск с новой версией (установленная) или страница загрузки (portable) */
    install: () => ipcRenderer.invoke('update:install'),
    onState: (cb) => {
      ipcRenderer.removeAllListeners('update');
      ipcRenderer.on('update', (_event, state) => cb(state));
    },
  },
  hotkeys: {
    /** → {binding} | {cleared:true} | null (Esc / тайм-аут) */
    record: () => ipcRenderer.invoke('hotkeys:record'),
    cancel: () => ipcRenderer.invoke('hotkeys:cancel'),
    /** cb({action, phase:'down'|'up'}) */
    onAction: (cb) => {
      ipcRenderer.removeAllListeners('hotkey');
      ipcRenderer.on('hotkey', (_event, e) => cb(e));
    },
  },
  server: {
    start: (port, password, allowedIps) => ipcRenderer.invoke('server:start', { port, password, allowedIps }),
    stop: () => ipcRenderer.invoke('server:stop'),
  },
  nativeCapture: {
    status: () => ipcRenderer.invoke('native-capture:status'),
    start: (sourceId, fps) => ipcRenderer.invoke('native-capture:start', { sourceId, fps }),
    stop: (session) => ipcRenderer.invoke('native-capture:stop', session),
    /** cb(imported, session): imported.getVideoFrame() даёт VideoFrame на GPU */
    onFrame: (cb) => {
      frameHandler = cb;
    },
    onEvent: (cb) => {
      ipcRenderer.removeAllListeners('native-capture:event');
      ipcRenderer.on('native-capture:event', (_event, e) => cb(e));
    },
  },
});
