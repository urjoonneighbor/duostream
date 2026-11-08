// Минимальный мост между интерфейсом (sandbox) и главным процессом. Тип API — src/shared/duo-api.d.ts.
import { contextBridge, ipcRenderer, sharedTexture, webUtils } from 'electron';
import type { DuoApi, ImportedTexture } from '../shared/duo-api';

// Кадры собственного захвата (см. src/main/native-capture.ts). Получатель регистрируется сразу:
// main не может отправить текстуру, пока его нет.
// Подписчиков может быть несколько: при смене источника старый и новый захват какое-то время работают
// вместе, и каждый трек берёт кадры только своей сессии.
type FrameHandler = (imported: ImportedTexture, session: number, width: number, height: number) => Promise<void> | void;
const frameHandlers = new Set<FrameHandler>();
if (typeof sharedTexture?.setSharedTextureReceiver === 'function') {
  sharedTexture.setSharedTextureReceiver(async (data, session, width, height) => {
    const imported = data.importedSharedTexture;
    try {
      await Promise.all([...frameHandlers].map((handler) => handler(imported, Number(session), Number(width), Number(height))));
    } finally {
      // Текстура вернётся процессу захвата, когда её отпустят и WebRTC, и мы
      imported.release();
    }
  });
}

/** Подписка на канал main → окно: прежний обработчик заменяется */
function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): void {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_event, ...args) => cb(...(args as A)));
}

const api: DuoApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  openConfigFile: () => ipcRenderer.invoke('config:open'),
  listSources: () => ipcRenderer.invoke('capture:list-sources'),
  selectSource: (source, audio) => ipcRenderer.invoke('capture:select', { id: source.id, name: source.name, audio }),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getPublicIp: () => ipcRenderer.invoke('net:public-ip'),
  focusWindow: () => ipcRenderer.invoke('app:focus'),
  log: (level, text) => ipcRenderer.send('log:write', level, text),
  revealLog: () => ipcRenderer.invoke('log:reveal'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  linkPreview: (url) => ipcRenderer.invoke('link:preview', url),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  saveLogImage: (dataUrl) => ipcRenderer.invoke('log:image', dataUrl),
  saveLogFrames: (label, frames) => ipcRenderer.invoke('log:frames', label, frames),
  onMainError: (cb) => subscribe('main-error', cb),
  onWindowVisibility: (cb) => subscribe('window:visibility', cb),
  avatar: {
    pick: () => ipcRenderer.invoke('avatar:pick'),
    commit: (crop) => ipcRenderer.invoke('avatar:commit', crop),
    cancelPick: () => ipcRenderer.invoke('avatar:cancel-pick'),
    setCrop: (crop) => ipcRenderer.invoke('avatar:set-crop', crop),
    get: () => ipcRenderer.invoke('avatar:get'),
    remove: () => ipcRenderer.invoke('avatar:remove'),
  },
  reactions: {
    list: () => ipcRenderer.invoke('reactions:list'),
    pickMedia: () => ipcRenderer.invoke('reactions:pick-media'),
    pickSound: () => ipcRenderer.invoke('reactions:pick-sound'),
    cancelPick: () => ipcRenderer.invoke('reactions:cancel-pick'),
    create: (input) => ipcRenderer.invoke('reactions:create', input),
    remove: (id) => ipcRenderer.invoke('reactions:remove', id),
    read: (hash) => ipcRenderer.invoke('reactions:read', hash),
  },
  overlay: {
    update: (state) => ipcRenderer.send('overlay:update', state),
    onState: (cb) => subscribe('overlay:state', cb),
  },
  files: {
    create: (name) => ipcRenderer.invoke('file:create', name),
    write: (id, offset, data) => ipcRenderer.invoke('file:write', id, offset, data),
    close: (id) => ipcRenderer.invoke('file:close', id),
    abort: (id) => ipcRenderer.invoke('file:abort', id),
    reveal: (file) => ipcRenderer.invoke('file:reveal', file),
    openRead: (file) => {
      const filePath = webUtils?.getPathForFile(file);
      if (!filePath) return Promise.reject(new Error('у файла нет пути на диске'));
      return ipcRenderer.invoke('upload:open', filePath);
    },
    read: (id, offset, length) => ipcRenderer.invoke('upload:read', id, offset, length),
    closeRead: (id) => ipcRenderer.invoke('upload:close', id),
  },
  appAudio: {
    start: (sourceId) => ipcRenderer.invoke('app-audio:start', sourceId),
    stop: (session) => ipcRenderer.invoke('app-audio:stop', session),
    onData: (cb) => subscribe('app-audio:data', cb),
    onEnded: (cb) => subscribe('app-audio:ended', cb),
  },
  upnp: {
    open: (tcp, udp) => ipcRenderer.invoke('upnp:open', { tcp, udp }),
    close: () => ipcRenderer.invoke('upnp:close'),
  },
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (cb) => subscribe('update', cb),
  },
  hotkeys: {
    record: () => ipcRenderer.invoke('hotkeys:record'),
    cancel: () => ipcRenderer.invoke('hotkeys:cancel'),
    onAction: (cb) => subscribe('hotkey', cb),
  },
  server: {
    start: (port, password, allowedIps) => ipcRenderer.invoke('server:start', { port, password, allowedIps }),
    stop: () => ipcRenderer.invoke('server:stop'),
  },
  nativeCapture: {
    status: () => ipcRenderer.invoke('native-capture:status'),
    start: (sourceId, fps) => ipcRenderer.invoke('native-capture:start', { sourceId, fps }),
    stop: (session) => ipcRenderer.invoke('native-capture:stop', session),
    setFps: (session, fps) => ipcRenderer.invoke('native-capture:fps', session, fps),
    onFrame: (cb) => {
      frameHandlers.add(cb);
      return () => frameHandlers.delete(cb);
    },
    onEvent: (cb) => subscribe('native-capture:event', cb),
  },
};

contextBridge.exposeInMainWorld('duo', api);
