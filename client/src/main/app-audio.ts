/**
 * Звук приложения транслируемого окна: duostream-capture.exe в режиме --audio-window захватывает звук
 * только процесса этого окна (и его дочерних) и пишет его в stdout — float32, стерео, 48 кГц.
 * Здесь поток режется на целые кадры и уходит в окно, где из него собирается звуковая дорожка.
 * Без этого при трансляции окна в стрим попадал весь системный звук (другие окна, музыка).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import type { WebContents } from 'electron';
import { helperPath } from './native-capture.ts';

const BYTES_PER_FRAME = 2 * 4; // стерео float32
const START_CHECK_MS = 500; // процесс захвата падает сразу, если Windows не умеет захват звука процесса

export class AppAudioCapture {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private sessionId = 0;

  /** @param sourceId window:<HWND>:… */
  start({ sourceId, webContents }: { sourceId: string; webContents: WebContents }): Promise<{ session: number }> {
    this.stop();
    const hwnd = /^window:(\d+):/.exec(sourceId)?.[1];
    if (!hwnd) return Promise.reject(new Error('звук приложения есть только у окна'));
    const exe = helperPath();
    if (!fs.existsSync(exe)) return Promise.reject(new Error('процесс захвата не собран'));

    const session = ++this.sessionId;
    const proc = spawn(exe, ['--parent', String(process.pid), '--audio-window', hwnd], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    let rest: Buffer = Buffer.alloc(0);
    let errorText = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      if (webContents.isDestroyed()) return;
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const usable = data.length - (data.length % BYTES_PER_FRAME);
      rest = data.subarray(usable);
      if (!usable) return;
      const samples = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + usable));
      webContents.send('app-audio:data', session, samples);
    });
    proc.stderr.on('data', (d: Buffer) => (errorText += String(d)));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ session }), START_CHECK_MS);
      const fail = (message: string) => {
        clearTimeout(timer);
        if (this.proc === proc) this.proc = null;
        reject(new Error(message));
      };
      proc.on('error', (err) => fail(`не удалось запустить захват звука: ${err.message}`));
      proc.on('exit', (code) => {
        if (this.proc !== proc) return; // штатная остановка
        this.proc = null;
        const message = errorText.replace(/^error:\s*/, '').trim() || `процесс захвата звука завершился (код ${code})`;
        fail(message);
        if (!webContents.isDestroyed()) webContents.send('app-audio:ended', session, message);
      });
    });
  }

  /** @param session остановить, только если это всё ещё текущий захват */
  stop(session?: number): void {
    if (session !== undefined && session !== this.sessionId) return;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdin.end(); // процесс захвата завершится сам
    } catch {
      // уже закрыт
    }
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill();
    }, 1000);
  }
}
