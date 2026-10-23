import crypto from 'node:crypto';

// Должно совпадать с client/src/renderer/js/crypto.js
export const KDF_SALT = 'duostream/v1';
export const KDF_ITERATIONS = 200_000;

const HEX64 = /^[0-9a-f]{64}$/;

/** Ключ HMAC из общего пароля (PBKDF2-SHA256, 32 байта). */
export function deriveKey(password) {
  return crypto.pbkdf2Sync(String(password), KDF_SALT, KDF_ITERATIONS, 32, 'sha256');
}

export function hmacHex(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !HEX64.test(a) || !HEX64.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Строка, которую клиент подписывает в ответ на challenge сервера. */
export const authMessage = (nonce, role) => `auth:${nonce}:${role}`;

/** Строка, которую клиент подписывает для каждого сигнального сообщения (сервер её не проверяет). */
export const signalMessage = (role, ts, payload) => `sig:${role}:${ts}:${payload}`;
