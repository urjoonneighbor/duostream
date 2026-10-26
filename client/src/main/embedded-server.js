'use strict';
/**
 * Встроенный сигнальный сервер: приложение стримера запускает тот же код, что server/src/server.js,
 * поэтому отдельный Node.js стримеру не нужен. В собранном приложении файлы сервера лежат
 * в app.asar/server (см. build.files в package.json), ws берётся из зависимостей приложения.
 */
const { app } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WebSocketServer } = require('ws');

function serverModulePath() {
  return app.isPackaged
    ? path.join(__dirname, '..', '..', 'server', 'server.js')
    : path.join(__dirname, '..', '..', '..', 'server', 'src', 'server.js');
}

class EmbeddedServer {
  constructor() {
    this.server = null;
    this.port = null;
    this.password = null;
  }

  /**
   * Запускает сервер или, если он уже работает с тем же портом и паролем, только обновляет allowedIps.
   * @returns {Promise<{port:number, lan:string[]}>}
   */
  async start({ port, password, allowedIps = [] }) {
    const mod = await import(pathToFileURL(serverModulePath()).href);
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

  async stop() {
    const server = this.server;
    this.server = null;
    if (server) await server.close();
  }
}

module.exports = { EmbeddedServer };
