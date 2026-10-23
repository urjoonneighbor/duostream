'use strict';
// Минимальный мост между интерфейсом (sandbox) и главным процессом.
const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

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
