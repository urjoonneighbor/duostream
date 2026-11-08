// Общее для передачи файлов кусками по каналу чата: аватарки (js/avatar-sync.ts) и реакции (js/reaction-sync.ts).

const DRAIN_POLL_MS = 1000; // bufferedamountlow может не прийти, если очередь опустела при закрытии канала

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ждём, пока очередь канала опустеет; по таймеру — на случай, если события не будет */
export function waitDrain(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', done);
      resolve();
    };
    const timer = setTimeout(done, DRAIN_POLL_MS);
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', done);
  });
}
