// Выбор видеокодека: AV1 → H264 → VP9 (порядок из конфига), аппаратные — вперёд.
// NVENC (RTX 40xx/50xx) кодирует AV1 и H.264/HEVC, но не VP9: VP9 в WebRTC пойдёт на CPU (libvpx).

const MIME = { AV1: 'video/AV1', H264: 'video/H264', VP9: 'video/VP9', VP8: 'video/VP8' };
const AUX = new Set(['RTX', 'RED', 'ULPFEC', 'FLEXFEC-03']);

const family = (codec) => codec.mimeType.split('/')[1].toUpperCase();

/**
 * Проверяет, какие кодеки браузер умеет отправлять и есть ли для них аппаратный энкодер
 * (MediaCapabilities.encodingInfo → powerEfficient).
 */
export async function probeVideoCodecs(names, video) {
  const send = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
  const results = [];
  for (const name of names) {
    const mime = MIME[name];
    const listed = Boolean(mime) && send.some((c) => c.mimeType.toLowerCase() === mime.toLowerCase());
    const result = { name, supported: listed, hardware: null, smooth: null };
    if (listed && navigator.mediaCapabilities?.encodingInfo) {
      try {
        const info = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: {
            contentType: mime,
            width: video.width || 1920,
            height: video.height || 1080,
            framerate: video.frameRate,
            bitrate: video.bitrateKbps * 1000,
          },
        });
        Object.assign(result, { supported: info.supported, hardware: info.powerEfficient, smooth: info.smooth });
      } catch {
        // Нет данных — решим по факту, глядя на encoderImplementation в статистике
      }
    }
    results.push(result);
  }
  return results;
}

export function orderCodecs(probe, preferHardware) {
  const usable = probe.filter((p) => p.supported);
  const ordered = preferHardware
    ? [...usable.filter((p) => p.hardware === true), ...usable.filter((p) => p.hardware !== true)]
    : usable;
  return ordered.map((p) => p.name);
}

/** Ставит выбранные кодеки первыми; остальные (VP8, RTX/RED/FEC) оставляет как запасные. */
export function applyCodecPreferences(transceiver, order) {
  if (!transceiver?.setCodecPreferences || !order?.length) return false;
  let lastError = null;
  for (const caps of [RTCRtpReceiver.getCapabilities('video'), RTCRtpSender.getCapabilities('video')]) {
    const codecs = caps?.codecs ?? [];
    const preferred = order.flatMap((name) => codecs.filter((c) => family(c) === name));
    const others = codecs.filter((c) => !preferred.includes(c) && !AUX.has(family(c)));
    const aux = codecs.filter((c) => AUX.has(family(c)));
    try {
      transceiver.setCodecPreferences([...preferred, ...others, ...aux]);
      return true;
    } catch (err) {
      lastError = err;
    }
  }
  console.warn('[codecs] setCodecPreferences не удалось:', lastError);
  return false;
}

/** true — аппаратный энкодер, false — программный, null — неизвестно */
export function encoderIsHardware(stat) {
  if (typeof stat.powerEfficientEncoder === 'boolean') return stat.powerEfficientEncoder;
  const impl = stat.encoderImplementation ?? '';
  if (/libaom|libvpx|openh264|libsvtav1|ffmpeg/i.test(impl)) return false;
  if (/mediafoundation|nvenc|externalencoder|videotoolbox|vaapi|d3d/i.test(impl)) return true;
  return null;
}

export function decoderIsHardware(stat) {
  if (typeof stat.powerEfficientDecoder === 'boolean') return stat.powerEfficientDecoder;
  const impl = stat.decoderImplementation ?? '';
  if (/dav1d|libvpx|ffmpeg|libaom|openh264/i.test(impl)) return false;
  if (/d3d11|mediafoundation|externaldecoder|videotoolbox|vaapi|dxva/i.test(impl)) return true;
  return null;
}
