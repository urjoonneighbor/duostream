// Правка SDP удалённой стороны перед setRemoteDescription.
// Правим именно удалённое описание: параметры отправки (битрейт, стерео Opus) WebRTC
// берёт из того, что прислал собеседник, а менять чужой текст разрешено всегда.

/** Порядок m-секций фиксирован: его задаёт стример при создании offer. */
export const MLINE = Object.freeze({ VOICE: 0, VIDEO: 1, SYSTEM: 2 });

const VIDEO_CODECS = ['AV1', 'VP9', 'H264', 'H265', 'VP8'];

function splitSections(sdp) {
  const lines = sdp.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const sections = [[]];
  for (const line of lines) {
    if (line.startsWith('m=')) sections.push([line]);
    else sections[sections.length - 1].push(line);
  }
  return sections;
}

const joinSections = (sections) => `${sections.flat().join('\r\n')}\r\n`;

function payloadTypes(section, codec) {
  const re = new RegExp(`^a=rtpmap:(\\d+) ${codec}/`, 'i');
  return section.map((line) => line.match(re)?.[1]).filter(Boolean);
}

function setFmtp(section, pt, params) {
  const prefix = `a=fmtp:${pt} `;
  const index = section.findIndex((line) => line.startsWith(prefix));
  const current = new Map();
  if (index >= 0) {
    for (const part of section[index].slice(prefix.length).split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) current.set(k, v.join('='));
    }
  }
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) current.delete(k);
    else current.set(k, String(v));
  }
  const line = `${prefix}${[...current].map(([k, v]) => `${k}=${v}`).join(';')}`;
  if (index >= 0) section[index] = line;
  else section.splice(section.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `)) + 1, 0, line);
}

function setBandwidth(section, kbps) {
  for (let i = section.length - 1; i >= 0; i--) {
    if (section[i].startsWith('b=AS:') || section[i].startsWith('b=TIAS:')) section.splice(i, 1);
  }
  if (!kbps) return;
  const c = section.findIndex((line) => line.startsWith('c='));
  section.splice(c >= 0 ? c + 1 : 1, 0, `b=AS:${kbps}`);
}

/**
 * @param {string} sdp удалённый offer/answer
 * @param {object} cfg stream.config.json
 * @param {{sendsVideo:boolean}} options sendsVideo — мы стример (отправляем видео)
 */
export function mungeRemoteSdp(sdp, cfg, { sendsVideo }) {
  const sections = splitSections(sdp);
  const { video, audio } = cfg;
  const startKbps = Math.min(video.bitrateKbps, Math.max(video.minBitrateKbps, Math.round(video.bitrateKbps / 2)));
  // x-google-*: нижняя граница, старт и потолок оценщика полосы WebRTC (кбит/с) на весь транспорт.
  // Голосовой канал libwebrtc тоже вызывает SetSdpBitrateParameters по параметрам своего кодека
  // (media/engine/webrtc_voice_engine.cc) и затирает значения видеоканала, поэтому у стримера
  // те же параметры дублируются в Opus — иначе минимум 8 Мбит/с и быстрый старт не работают.
  const bwe = sendsVideo
    ? {
        'x-google-min-bitrate': video.minBitrateKbps || null,
        'x-google-start-bitrate': startKbps,
        'x-google-max-bitrate': video.bitrateKbps,
      }
    : {};

  sections.slice(1).forEach((section, index) => {
    const kind = section[0].slice(2, section[0].indexOf(' '));
    if (kind === 'audio') {
      const params =
        index === MLINE.SYSTEM
          ? { stereo: 1, 'sprop-stereo': 1, maxaveragebitrate: audio.systemAudioBitrateKbps * 1000, useinbandfec: 1 }
          : { stereo: 0, maxaveragebitrate: audio.voiceBitrateKbps * 1000, useinbandfec: 1, usedtx: 0, minptime: 10 };
      for (const pt of payloadTypes(section, 'opus')) setFmtp(section, pt, { ...params, ...bwe });
    } else if (kind === 'video' && sendsVideo) {
      for (const codec of VIDEO_CODECS) for (const pt of payloadTypes(section, codec)) setFmtp(section, pt, bwe);
      setBandwidth(section, video.bitrateKbps);
    }
  });
  return joinSections(sections);
}
