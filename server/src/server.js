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
  // Кому можно подключаться: IP или подсети IPv4 вида 203.0.113.0/24. Пусто — всем (вход всё равно по паролю).
  // С остальных адресов соединение рвётся сразу, сервер им ничего не отвечает. 127.0.0.1 разрешён всегда.
  allowedIps: [],
};

/** Энтропия пароля, грубая оценка: длина × log2(размер алфавита по классам символов). */
function passwordBits(password) {
  const classes = [
    [/[a-z]/, 26],
    [/[A-Z]/, 26],
    [/[0-9]/, 10],
    [/[а-яё]/, 33],
    [/[А-ЯЁ]/, 33],
    [/[^a-zA-Z0-9а-яёА-ЯЁ]/, 33],
  ];
  const alphabet = classes.reduce((sum, [re, size]) => sum + (re.test(password) ? size : 0), 0);
  return [...password].length * Math.log2(Math.max(alphabet, 2));
}

const COMMON_PASSWORDS = /^(?:qwerty|password|пароль|123456|111111|admin|letmein|iloveyou|йцукен|duostream)/i;

/**
 * Почему пароль слабый (null — подходит). Ориентир — 60 бит: например, 12 символов из букв разного
 * регистра и цифр. Перебор после перехвата входа по сети (ws:// не шифруется) тогда нереален.
 */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'пароль короче 8 символов';
  if (new Set(password).size < 6) return 'в пароле меньше 6 разных символов';
  if (COMMON_PASSWORDS.test(password)) return 'пароль начинается с распространённого слова';
  if (passwordBits(password) < 60) {
    return 'пароль слишком простой: нужно от 12 символов из букв разного регистра и цифр (или от 16 из одних маленьких букв)';
  }
  return null;
}

/** IPv4 или IPv4-подсеть «a.b.c.d/n» → проверка адреса; IPv6 — только точное совпадение. */
function ipMatcher(entry) {
  const text = String(entry).trim();
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(text);
  if (!m) return (ip) => ip.toLowerCase() === text.toLowerCase();
  const bits = m[2] === undefined ? 32 : Math.min(32, Number(m[2]));
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  const toInt = (ip) => ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
  const net = (toInt(m[1]) & mask) >>> 0; // & даёт знаковое число, сравниваем беззнаковые
  return (ip) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) && (toInt(ip) & mask) >>> 0 === net;
}

export function isValidIpEntry(entry) {
  const text = String(entry).trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(text);
  if (v4) return v4.slice(1, 5).every((p) => Number(p) <= 255) && (v4[5] === undefined || Number(v4[5]) <= 32);
  return /^[0-9a-f:]+$/i.test(text) && text.includes(':');
}

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

/** Читает config.json и накладывает переменные окружения DUO_HOST / DUO_PORT / DUO_PASSWORD / DUO_ALLOWED_IPS. */
export function loadConfig(file) {
  let fromFile = {};
  if (file && fs.existsSync(file)) {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const cfg = { ...DEFAULT_CONFIG, ...fromFile };
  if (process.env.DUO_HOST) cfg.host = process.env.DUO_HOST;
  if (process.env.DUO_PORT) cfg.port = Number(process.env.DUO_PORT);
  if (process.env.DUO_PASSWORD) cfg.password = process.env.DUO_PASSWORD;
  if (process.env.DUO_ALLOWED_IPS) cfg.allowedIps = process.env.DUO_ALLOWED_IPS.split(/[\s,]+/).filter(Boolean);
  return cfg;
}

export function validateConfig(cfg) {
  const problems = [];
  const weak = passwordProblem(cfg.password);
  if (weak) problems.push(`password: ${weak} (config.json или переменная DUO_PASSWORD)`);
  const ips = cfg.allowedIps ?? [];
  if (!Array.isArray(ips)) problems.push('allowedIps: должен быть списком адресов');
  else for (const entry of ips) if (!isValidIpEntry(entry)) problems.push(`allowedIps: некорректный адрес «${entry}»`);
  // 0 = любой свободный порт (используется в тестах)
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    problems.push(`port: некорректный порт ${cfg.port}`);
  }
  return problems;
}

/**
 * @param {object} config см. DEFAULT_CONFIG
 * @param {{WebSocketServer: typeof import('ws').WebSocketServer, log?: Function}} deps класс WebSocketServer
 *   из пакета ws передаётся снаружи: так этот файл без своих зависимостей загружается и из приложения
 *   стримера (встроенный сервер, ws — зависимость приложения), и отдельным процессом (main ниже).
 */
export function createSignalingServer(config, { WebSocketServer, log = defaultLog }) {
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

  // Обычные HTTP-запросы (сканеры, браузер) получают пустой 404 — сервер себя не называет.
  // Для проверки проброса порта этого достаточно: ошибка 404 вместо «не удаётся подключиться».
  const httpServer = http.createServer((req, res) => {
    res.writeHead(404, { connection: 'close' });
    res.end();
  });

  let allowed = cfg.allowedIps.map(ipMatcher);
  const isAllowed = (ip) => !allowed.length || /^(127\.|::1$)/.test(ip) || allowed.some((match) => match(ip));
  const lastRejectLog = new Map();
  // Чужие адреса отсекаются на уровне TCP — до TLS/HTTP/WebSocket и проверки пароля
  httpServer.on('connection', (socket) => {
    const ip = (socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
    if (isAllowed(ip)) return;
    socket.destroy();
    const now = Date.now();
    if (now - (lastRejectLog.get(ip) ?? 0) > 60_000) {
      lastRejectLog.set(ip, now);
      if (lastRejectLog.size > 1000) lastRejectLog.clear();
      log(`Отклонено подключение с ${ip}: адреса нет в allowedIps`);
    }
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

  // Стример видит IP зрителя (это его сервер) — чтобы добавить его в allowedIps; зрителю IP стримера не нужен
  const peerInfo = (c, to) => (c ? { role: c.role, name: c.name, ...(to?.role === 'streamer' ? { ip: c.ip } : {}) } : null);

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
    send(client.ws, { type: 'welcome', role: client.role, peer: peerInfo(peer, client) });
    if (peer) send(peer.ws, { type: 'peer-joined', peer: peerInfo(client, peer) });
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
    /** Новый список allowedIps без перезапуска; уже подключённые с чужих адресов отключаются. */
    setAllowedIps(list) {
      const bad = list.filter((entry) => !isValidIpEntry(entry));
      if (bad.length) throw new Error(`allowedIps: некорректный адрес «${bad[0]}»`);
      allowed = list.map(ipMatcher);
      for (const client of slots.values()) {
        if (!isAllowed(client.ip)) client.ws.close(CLOSE.AUTH_FAILED, 'not-allowed');
      }
    },
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

export function lanAddresses() {
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

  const { WebSocketServer } = await import('ws');
  const server = createSignalingServer(cfg, { WebSocketServer });
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
