'use strict';
/**
 * Собственный захват экрана/окна (native/bin/duostream-capture.exe) для обхода предела ~60 FPS
 * встроенного захвата Chromium на Windows 11 24H2+.
 *
 * Процесс захвата кладёт кадры в кольцо общих D3D11-текстур и присылает номер текстуры.
 * Здесь текстура импортируется через sharedTexture и уходит в окно, где из неё получается
 * VideoFrame для WebRTC — без копирования в оперативную память. Когда Chromium перестаёт
 * использовать текстуру (allReferencesReleased), процесс захвата получает её обратно.
 */
const { app, desktopCapturer, screen, sharedTexture } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const EXE_NAME = 'duostream-capture.exe';
const FIRST_FRAME_TIMEOUT_MS = 4000;
const MAX_SEND_ERRORS = 30;

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native', EXE_NAME)
    : path.join(__dirname, '..', '..', 'native', 'bin', EXE_NAME);
}

function handleBuffer(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

class NativeCapture {
  constructor() {
    this.proc = null;
    this.sessionId = 0;
    this.gpu = null;
  }

  /** Можно ли использовать собственный захват на этом ПК. */
  status() {
    if (process.platform !== 'win32') return { available: false, reason: 'только для Windows' };
    const build = Number(os.release().split('.')[2] ?? 0);
    if (build < 19041) return { available: false, reason: `нужна Windows 10 2004 или новее (сборка ${build})` };
    if (typeof sharedTexture?.importSharedTexture !== 'function') return { available: false, reason: 'в этой версии Electron нет sharedTexture' };
    const exe = helperPath();
    if (!fs.existsSync(exe)) return { available: false, reason: 'не собран: выполните npm run build:native (нужен .NET SDK 10)' };
    return { available: true, path: exe };
  }

  /** Видеокарта, на которой работает Chromium: текстуры нужно создавать на ней же. */
  async activeGpu() {
    if (this.gpu) return this.gpu;
    try {
      const info = await app.getGPUInfo('complete');
      const active = (info.gpuDevice ?? []).find((d) => d.active);
      if (active) this.gpu = { vendorId: active.vendorId >>> 0, deviceId: active.deviceId >>> 0, name: active.deviceString ?? '' };
    } catch {
      // без указания видеокарты процесс захвата возьмёт адаптер по умолчанию
    }
    return this.gpu;
  }

  /** Аргументы источника для процесса захвата по id из desktopCapturer. */
  async targetArgs(sourceId) {
    const win = /^window:(\d+):/.exec(sourceId);
    if (win) return ['--window', win[1]];
    if (!sourceId.startsWith('screen:')) throw new Error(`неизвестный источник ${sourceId}`);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find((s) => s.id === sourceId);
    const display = screen.getAllDisplays().find((d) => String(d.id) === String(source?.display_id));
    if (!display) throw new Error('монитор не найден');
    // Центр монитора в физических пикселях — по нему процесс захвата находит HMONITOR
    const center = screen.dipToScreenPoint({
      x: Math.round(display.bounds.x + display.bounds.width / 2),
      y: Math.round(display.bounds.y + display.bounds.height / 2),
    });
    return ['--point', `${Math.round(center.x)},${Math.round(center.y)}`];
  }

  /**
   * Запускает захват и ждёт первый кадр.
   * @param {{sourceId:string, fps:number, webContents:Electron.WebContents, onEvent:(e:object)=>void}} options
   * @returns {Promise<{session:number, width:number, height:number, adapter:string}>}
   */
  async start({ sourceId, fps, webContents, onEvent }) {
    this.stop();
    const status = this.status();
    if (!status.available) throw new Error(status.reason);

    const args = ['--parent', String(process.pid), '--fps', String(fps), ...(await this.targetArgs(sourceId))];
    const gpu = await this.activeGpu();
    if (gpu) args.push('--gpu', `${gpu.vendorId}:${gpu.deviceId}`);

    const session = ++this.sessionId;
    const proc = spawn(status.path, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    const write = (line) => {
      if (proc.stdin.writable) proc.stdin.write(`${line}\n`);
    };

    return new Promise((resolve, reject) => {
      let started = false;
      let ring = null;
      let adapter = '';
      let lastSize = '';
      let sendErrors = 0;
      let inFlight = 0; // текстуры, которые ещё держат Electron/WebRTC

      const finish = (error) => {
        clearTimeout(timer);
        if (this.proc === proc) this.stop();
        if (!started) reject(error);
        else onEvent({ session, type: 'error', message: error.message });
      };
      const timer = setTimeout(() => finish(new Error('нет кадров от захвата за 4 с')), FIRST_FRAME_TIMEOUT_MS);

      proc.on('error', (err) => finish(new Error(`не удалось запустить захват: ${err.message}`)));
      proc.on('exit', (code) => {
        // Штатная остановка (stop()) сначала обнуляет this.proc — тогда это не ошибка
        if (this.proc === proc) finish(new Error(`процесс захвата завершился (код ${code})`));
      });
      proc.stderr.on('data', (d) => console.warn(`[native-capture] ${String(d).trim()}`));

      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        if (this.proc !== proc) return;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'ready':
            ring = { gen: msg.gen, width: msg.width, height: msg.height, handles: msg.handles.map(handleBuffer) };
            adapter = msg.adapter;
            write(`gen ${msg.gen}`);
            break;
          case 'frame': {
            if (!ring || msg.gen !== ring.gen || webContents.isDestroyed()) {
              write(`free ${msg.gen} ${msg.i}`);
              return;
            }
            let texture;
            try {
              texture = sharedTexture.importSharedTexture({
                textureInfo: {
                  pixelFormat: 'bgra',
                  codedSize: { width: ring.width, height: ring.height },
                  visibleRect: { x: 0, y: 0, width: msg.w, height: msg.h },
                  handle: { ntHandle: ring.handles[msg.i] },
                  timestamp: msg.ts,
                },
                allReferencesReleased: () => {
                  inFlight--;
                  write(`free ${msg.gen} ${msg.i}`);
                },
              });
              inFlight++;
            } catch (err) {
              finish(new Error(`импорт текстуры не удался: ${err.message}`));
              return;
            }
            sharedTexture
              .sendSharedTexture({ frame: webContents.mainFrame, importedSharedTexture: texture }, session)
              .then(() => {
                sendErrors = 0;
              })
              .catch((err) => {
                if (++sendErrors >= MAX_SEND_ERRORS) finish(new Error(`окно не принимает кадры: ${err.message}`));
              })
              .finally(() => texture.release());

            const size = `${msg.w}x${msg.h}`;
            if (!started) {
              started = true;
              lastSize = size;
              clearTimeout(timer);
              resolve({ session, width: msg.w, height: msg.h, adapter });
            } else if (size !== lastSize) {
              lastSize = size;
              onEvent({ session, type: 'size', width: msg.w, height: msg.h });
            }
            break;
          }
          case 'stats':
            onEvent({ session, type: 'stats', fps: msg.fps, dropped: msg.dropped, copyMs: msg.copyMs, inFlight });
            break;
          case 'closed':
            clearTimeout(timer);
            this.stop();
            if (started) onEvent({ session, type: 'closed' });
            else reject(new Error('источник закрыт'));
            break;
          case 'error':
            finish(new Error(msg.message));
            break;
          default:
            break;
        }
      });
    });
  }

  /** @param {number} [session] остановить, только если это всё ещё текущий захват */
  stop(session) {
    if (session !== undefined && session !== this.sessionId) return;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    // Конец stdin — процесс закроет свои хэндлы в нашем процессе и выйдет сам
    try {
      proc.stdin.end();
    } catch {
      // уже закрыт
    }
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill();
    }, 1500);
  }
}

module.exports = { NativeCapture };
