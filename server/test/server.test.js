import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createSignalingServer, validateConfig, PROTOCOL_VERSION } from '../src/server.js';
import { deriveKey, hmacHex, authMessage } from '../src/crypto.js';

const PASSWORD = 'correct-horse-battery';
const KEY = deriveKey(PASSWORD);

async function startServer(extra = {}) {
  const server = createSignalingServer(
    { host: '127.0.0.1', port: 0, password: PASSWORD, heartbeatSeconds: 60, ...extra },
    { log: () => {} },
  );
  const { port } = await server.listen();
  return { server, port };
}

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const next = (timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift());
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  return { ws, next, closed, send: (msg) => ws.send(JSON.stringify(msg)) };
}

async function login(port, role, key = KEY) {
  const client = connect(port);
  const challenge = await client.next();
  assert.equal(challenge.type, 'challenge');
  assert.equal(challenge.version, PROTOCOL_VERSION);
  client.send({
    type: 'hello',
    role,
    name: `${role}-name`,
    version: PROTOCOL_VERSION,
    proof: hmacHex(key, authMessage(challenge.nonce, role)),
  });
  return client;
}

test('пара стример + зритель собирается и сигналы пересылаются без изменений', async () => {
  const { server, port } = await startServer();
  try {
    const streamer = await login(port, 'streamer');
    assert.deepEqual(await streamer.next(), { type: 'welcome', role: 'streamer', peer: null });

    const viewer = await login(port, 'viewer');
    assert.deepEqual(await viewer.next(), {
      type: 'welcome',
      role: 'viewer',
      peer: { role: 'streamer', name: 'streamer-name' },
    });
    assert.deepEqual(await streamer.next(), { type: 'peer-joined', peer: { role: 'viewer', name: 'viewer-name' } });

    const signal = { type: 'signal', payload: '{"kind":"answer","sdp":"v=0"}', ts: 1234, sig: 'ab'.repeat(32) };
    viewer.send(signal);
    assert.deepEqual(await streamer.next(), { ...signal, from: 'viewer' });

    viewer.ws.close();
    assert.deepEqual(await streamer.next(), { type: 'peer-left', role: 'viewer' });
    streamer.ws.close();
  } finally {
    await server.close();
  }
});

test('неверный пароль отклоняется с кодом 4002', async () => {
  const { server, port } = await startServer();
  try {
    const intruder = await login(port, 'viewer', deriveKey('wrong-password'));
    const error = await intruder.next();
    assert.equal(error.type, 'error');
    assert.equal(error.code, 'auth-failed');
    assert.equal(await intruder.closed, 4002);
  } finally {
    await server.close();
  }
});

test('после нескольких неудачных попыток IP блокируется', async () => {
  const { server, port } = await startServer({ authFailLimit: 2, authBanSeconds: 60 });
  try {
    for (let i = 0; i < 2; i++) {
      const c = await login(port, 'viewer', deriveKey('nope-nope-nope'));
      await c.next();
      await c.closed;
    }
    const banned = connect(port);
    const msg = await banned.next();
    assert.equal(msg.code, 'banned');
    assert.equal(await banned.closed, 4003);
  } finally {
    await server.close();
  }
});

test('повторный вход с той же ролью вытесняет старое соединение', async () => {
  const { server, port } = await startServer();
  try {
    const viewer = await login(port, 'viewer');
    await viewer.next(); // welcome

    const first = await login(port, 'streamer');
    await first.next(); // welcome
    await viewer.next(); // peer-joined

    const second = await login(port, 'streamer');
    const kicked = await first.next();
    assert.equal(kicked.code, 'replaced');
    assert.equal(await first.closed, 4004);
    assert.equal((await second.next()).type, 'welcome');
    assert.deepEqual(await viewer.next(), { type: 'peer-joined', peer: { role: 'streamer', name: 'streamer-name' } });

    viewer.ws.close();
    second.ws.close();
  } finally {
    await server.close();
  }
});

test('сигнал без второго участника возвращает no-peer, без hello — not-authenticated', async () => {
  const { server, port } = await startServer();
  try {
    const anon = connect(port);
    await anon.next(); // challenge
    anon.send({ type: 'signal', payload: '{}', ts: 1, sig: 'x' });
    assert.equal((await anon.next()).code, 'not-authenticated');
    anon.ws.close();

    const streamer = await login(port, 'streamer');
    await streamer.next(); // welcome
    streamer.send({ type: 'signal', payload: '{}', ts: 1, sig: 'x' });
    assert.equal((await streamer.next()).code, 'no-peer');
    streamer.ws.close();
  } finally {
    await server.close();
  }
});

test('короткий пароль не принимается конфигурацией', () => {
  assert.equal(validateConfig({ password: 'short', port: 8787 }).length, 1);
  assert.equal(validateConfig({ password: 'long-enough-password', port: 8787 }).length, 0);
});
