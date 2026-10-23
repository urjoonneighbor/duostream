#!/usr/bin/env node
/**
 * DuoStream — сигнальный сервер.
 *
 * Задача сервера — только свести двух участников (стример + зритель) и переслать
 * между ними SDP offer/answer и ICE-кандидаты. Видео и звук идут напрямую P2P.
 *
 * Протокол (JSON поверх WebSocket):
 *   S→C  {type:'challenge', nonce, version}
 *   C→S  {type:'hello', role:'streamer'|'viewer', name, proof, version}
 *          proof = HMAC(PBKDF2(password), `auth:${nonce}:${role}`)
 *   S→C  {type:'welcome', role, peer:{role,name}|null}
 *   S→C  {type:'peer-joined', peer:{role,name}} / {type:'peer-left', role}
 *   C→S  {type:'signal', payload:'<json>', ts, sig}   → пересылается второму участнику
 *   S→C  {type:'error', code, message}
 *
 * Подпись `sig` ставит и проверяет сам клиент (HMAC общим паролем), поэтому подменить
 * SDP (а значит и DTLS-отпечатки) по дороге нельзя, даже если сервер или канал скомпрометирован.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { deriveKey, hmacHex, safeEqualHex, authMessage } from './crypto.js';

export const PROTOCOL_VERSION = 1;
const ROLES = new Set(['streamer', 'viewer']);
const OTHER = { streamer: 'viewer', viewer: 'streamer' };

export const DEFAULT_CONFIG = {
  host: '0.0.0.0',
  port: 8787,
  password: '',
  maxMessageBytes: 256 * 1024,
  heartbeatSeconds: 15,
  authTimeoutSeconds: 10,
  authFailLimit: 5,
  authBanSeconds: 300,
};

const CLOSE = {
  AUTH_TIMEOUT: 4001,
  AUTH_FAILED: 4002,
  BANNED: 4003,
  REPLACED: 4004,
  BAD_VERSION: 4005,
  RATE_LIMIT: 4008,
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const defaultLog = (...args) => console.log(`[${timestamp()}]`, ...args);

/** Читает config.json и накладывает переменные окружения DUO_HOST / DUO_PORT / DUO_PASSWORD. */
export function loadConfig(file) {
  let fromFile = {};
  if (file && fs.existsSync(file)) {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const cfg = { ...DEFAULT_CONFIG, ...fromFile };
  if (process.env.DUO_HOST) cfg.host = process.env.DUO_HOST;
  if (process.env.DUO_PORT) cfg.port = Number(process.env.DUO_PORT);
  if (process.env.DUO_PASSWORD) cfg.password = process.env.DUO_PASSWORD;
  return cfg;
}

export function validateConfig(cfg) {
  const problems = [];
  if (typeof cfg.password !== 'string' || cfg.password.length < 8) {
    problems.push('password: задайте общий пароль длиной от 8 символов (config.json или переменная DUO_PASSWORD)');
  }
  // 0 = любой свободный порт (используется в тестах)
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    problems.push(`port: некорректный порт ${cfg.port}`);
  }
  return problems;
}

export function createSignalingServer(config, { log = defaultLog } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const problems = validateConfig(cfg);
  if (problems.length) throw new Error(problems.join('\n'));

  const key = deriveKey(cfg.password);
  /** @type {Map<string, Client>} роль → клиент */
  const slots = new Map();
  /** @type {Map<string, {count:number, bannedUntil:number}>} */
  const failures = new Map();
  /** Сокеты, ответившие на последний ping */
  const aliveSockets = new WeakSet();

  const httpServer = http.createServer((req, res) => {
    // Удобно для проверки проброса порта из браузера: http://<белый IP>:<порт>/
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('DuoStream signaling server: OK\n');
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: cfg.maxMessageBytes,
    perMessageDeflate: false,
  });

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const fail = (client, code, message, closeCode) => {
    send(client.ws, { type: 'error', code, message });
    if (closeCode) client.ws.close(closeCode, code);
  };

  const isBanned = (ip) => {
    const f = failures.get(ip);
    return Boolean(f && f.bannedUntil > Date.now());
  };

  const registerFailure = (ip) => {
    const f = failures.get(ip) ?? { count: 0, bannedUntil: 0 };
    f.count += 1;
    if (f.count >= cfg.authFailLimit) {
      f.bannedUntil = Date.now() + cfg.authBanSeconds * 1000;
      f.count = 0;
      log(`IP ${ip} заблокирован на ${cfg.authBanSeconds} с после неудачных попыток входа`);
    }
    failures.set(ip, f);
  };

  const peerInfo = (c) => (c ? { role: c.role, name: c.name } : null);

  function handleHello(client, msg) {
    if (client.role) return fail(client, 'already-authenticated', 'Повторный hello');
    if (msg.version !== PROTOCOL_VERSION) {
      return fail(client, 'bad-version', `Версия протокола клиента ${msg.version}, сервера ${PROTOCOL_VERSION}`, CLOSE.BAD_VERSION);
    }
    if (!ROLES.has(msg.role)) return fail(client, 'bad-role', 'Роль должна быть streamer или viewer', CLOSE.AUTH_FAILED);

    const expected = hmacHex(key, authMessage(client.nonce, msg.role));
    if (!safeEqualHex(expected, msg.proof)) {
      registerFailure(client.ip);
      log(`Неверный пароль от ${client.ip} (роль ${msg.role})`);
      return fail(client, 'auth-failed', 'Неверный пароль', CLOSE.AUTH_FAILED);
    }
    failures.delete(client.ip);
    clearTimeout(client.authTimer);

    client.role = msg.role;
    client.name = String(msg.name ?? '').slice(0, 64) || (msg.role === 'streamer' ? 'Стример' : 'Зритель');

    // Повторный вход с той же ролью (перезапуск приложения, обрыв сети) вытесняет старое соединение.
    const previous = slots.get(client.role);
    if (previous && previous !== client) {
      previous.replaced = true;
      fail(previous, 'replaced', 'Выполнен вход с этой ролью с другого подключения', CLOSE.REPLACED);
      log(`${client.role}: старое соединение ${previous.ip} вытеснено новым ${client.ip}`);
    }
    slots.set(client.role, client);

    const peer = slots.get(OTHER[client.role]) ?? null;
    send(client.ws, { type: 'welcome', role: client.role, peer: peerInfo(peer) });
    if (peer) send(peer.ws, { type: 'peer-joined', peer: peerInfo(client) });
    log(`${client.role} "${client.name}" вошёл с ${client.ip}${peer ? ` — пара собрана (${peer.role} "${peer.name}")` : ''}`);
  }

  function handleSignal(client, msg) {
    if (!client.role) return fail(client, 'not-authenticated', 'Сначала hello');
    if (typeof msg.payload !== 'string' || typeof msg.sig !== 'string' || !Number.isFinite(msg.ts)) {
      return fail(client, 'bad-signal', 'Некорректное сигнальное сообщение');
    }
    const peer = slots.get(OTHER[client.role]);
    if (!peer) return fail(client, 'no-peer', 'Второй участник ещё не подключился');
    send(peer.ws, { type: 'signal', from: client.role, payload: msg.payload, ts: msg.ts, sig: msg.sig });
  }

  wss.on('connection', (ws, req) => {
    const ip = (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
    const client = {
      ws,
      ip,
      role: null,
      name: '',
      nonce: crypto.randomBytes(32).toString('hex'),
      replaced: false,
      msgWindowStart: Date.now(),
      msgCount: 0,
      authTimer: null,
    };

    if (isBanned(ip)) {
      fail(client, 'banned', 'Слишком много неудачных попыток входа, попробуйте позже', CLOSE.BANNED);
      return;
    }

    client.authTimer = setTimeout(() => {
      if (!client.role) fail(client, 'auth-timeout', 'Не получен hello', CLOSE.AUTH_TIMEOUT);
    }, cfg.authTimeoutSeconds * 1000);

    aliveSockets.add(ws);
    ws.on('pong', () => aliveSockets.add(ws));

    ws.on('message', (data, isBinary) => {
      // Простейший лимит: не больше 300 сообщений за 10 секунд
      const now = Date.now();
      if (now - client.msgWindowStart > 10_000) {
        client.msgWindowStart = now;
        client.msgCount = 0;
      }
      if (++client.msgCount > 300) return fail(client, 'rate-limit', 'Слишком много сообщений', CLOSE.RATE_LIMIT);
      if (isBinary) return fail(client, 'bad-message', 'Ожидается текстовый JSON');

      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return fail(client, 'bad-json', 'Некорректный JSON');
      }
      if (msg?.type === 'hello') handleHello(client, msg);
      else if (msg?.type === 'signal') handleSignal(client, msg);
      else fail(client, 'unknown-type', `Неизвестный тип сообщения: ${msg?.type}`);
    });

    ws.on('close', () => {
      clearTimeout(client.authTimer);
      if (client.role && slots.get(client.role) === client) {
        slots.delete(client.role);
        const peer = slots.get(OTHER[client.role]);
        if (peer) send(peer.ws, { type: 'peer-left', role: client.role });
        log(`${client.role} "${client.name}" отключился`);
      }
    });

    ws.on('error', (err) => log(`Ошибка сокета ${ip}: ${err.message}`));

    send(ws, { type: 'challenge', nonce: client.nonce, version: PROTOCOL_VERSION });
  });

  // Пинг на уровне WebSocket: мёртвые соединения (обрыв без FIN) закрываются за 2 интервала
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!aliveSockets.has(ws)) {
        ws.terminate();
        continue;
      }
      aliveSockets.delete(ws);
      ws.ping();
    }
  }, cfg.heartbeatSeconds * 1000);

  return {
    httpServer,
    wss,
    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(cfg.port, cfg.host, () => {
          httpServer.off('error', reject);
          resolve(httpServer.address());
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => httpServer.close(() => resolve())));
    },
  };
}

function lanAddresses() {
  const result = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) result.push(`${a.address} (${name})`);
    }
  }
  return result;
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const configPath = process.env.DUO_CONFIG ?? path.join(here, '..', 'config.json');
  const cfg = loadConfig(configPath);
  const problems = validateConfig(cfg);
  if (problems.length) {
    console.error(`Ошибка конфигурации (${configPath}):\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }

  const server = createSignalingServer(cfg);
  try {
    await server.listen();
  } catch (err) {
    console.error(`Не удалось открыть порт ${cfg.port}: ${err.message}`);
    process.exit(1);
  }

  defaultLog(`Сигнальный сервер DuoStream слушает ${cfg.host}:${cfg.port}`);
  defaultLog(`Стример подключается к ws://127.0.0.1:${cfg.port}`);
  defaultLog(`Зритель подключается к ws://<ваш белый IP>:${cfg.port}`);
  const lan = lanAddresses();
  if (lan.length) defaultLog(`Локальные адреса этого ПК (для проброса портов на роутере): ${lan.join(', ')}`);

  const shutdown = async () => {
    defaultLog('Остановка...');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
