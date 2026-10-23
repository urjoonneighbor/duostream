// Аутентификация на сигнальном сервере и подпись сигнальных сообщений общим паролем.
// Параметры должны совпадать с server/src/crypto.js.
const KDF_SALT = 'duostream/v1';
const KDF_ITERATIONS = 200_000;

const encoder = new TextEncoder();

const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]*$/.test(hex) || hex.length % 2) return new Uint8Array(0);
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

/** PBKDF2-SHA256(password) → ключ HMAC-SHA256 */
export async function deriveKey(password) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(KDF_SALT), iterations: KDF_ITERATIONS },
    base,
    256,
  );
  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmacHex(key, message) {
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

export async function hmacVerify(key, message, hex) {
  return crypto.subtle.verify('HMAC', key, fromHex(hex), encoder.encode(message));
}

export const authMessage = (nonce, role) => `auth:${nonce}:${role}`;
export const signalMessage = (role, ts, payload) => `sig:${role}:${ts}:${payload}`;
