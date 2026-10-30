/**
 * Встроенный сигнальный сервер: приложение стримера запускает тот же код, что server/src/server.ts
 * (собранный в server/dist), поэтому отдельный Node.js стримеру не нужен. В собранном приложении файлы
 * сервера лежат в app.asar/server (см. build.files в package.json), ws берётся из зависимостей приложения.
 */
import { app } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

/** То, что main берёт из server/src/server.ts (модуль ESM, грузится через import()) */
interface SignalingServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  setAllowedIps(list: string[]): void;
}
interface ServerModule {
  lanAddresses(): string[];
  createSignalingServer(
    options: { host: string; port: number; password: string; allowedIps: string[] },
    deps: { WebSocketServer: typeof WebSocketServer; log: (...args: unknown[]) => void },
  ): SignalingServer;
}

function serverModulePath(): string {
  return app.isPackaged
    ? path.join(__dirname, '..', '..', 'server', 'server.js')
    : path.join(__dirname, '..', '..', '..', 'server', 'dist', 'server.js');
}

export class EmbeddedServer {
  private server: SignalingServer | null = null;
  private port: number | null = null;
  private password: string | null = null;

  /** Запускает сервер или, если он уже работает с тем же портом и паролем, только обновляет allowedIps. */
  async start({ port, password, allowedIps = [] }: { port: number; password: string; allowedIps?: string[] }): Promise<{
    port: number;
    lan: string[];
  }> {
    // Адрес — в отдельной переменной: внутри import(…) TypeScript 7 при rewriteRelativeImportExtensions
    // не переписывает обращение к импортированной функции, и в CJS получается ReferenceError
    const url = pathToFileURL(serverModulePath()).href;
    const mod: ServerModule = await import(url);
    if (this.server && this.port === port && this.password === password) {
      this.server.setAllowedIps(allowedIps);
      return { port, lan: mod.lanAddresses() };
    }
    await this.stop();

    const server = mod.createSignalingServer(
      { host: '0.0.0.0', port, password, allowedIps },
      { WebSocketServer, log: (...args) => console.log('[server]', ...args) },
    );
    try {
      await server.listen();
    } catch (err) {
      await server.close().catch(() => {});
      throw err;
    }
    Object.assign(this, { server, port, password });
    console.log(`[server] встроенный сигнальный сервер слушает 0.0.0.0:${port}`);
    return { port, lan: mod.lanAddresses() };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await server.close();
  }
}
