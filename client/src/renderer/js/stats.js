// Сбор и оценка статистики WebRTC (раз в секунду): битрейт, пинг, потери, FPS,
// кодек и признак аппаратного кодирования/декодирования, тип пути (P2P или TURN).
import { encoderIsHardware, decoderIsHardware } from './codecs.js';

const codecName = (byId, id) => byId.get(id)?.mimeType?.split('/')[1]?.toUpperCase() ?? null;

export class StatsMonitor {
  constructor(session) {
    this.session = session;
    this.prev = new Map();
  }

  async sample() {
    const report = await this.session.pc.getStats();
    const byId = new Map();
    report.forEach((s) => byId.set(s.id, s));

    const rate = (s, field) => {
      const p = this.prev.get(s.id);
      if (!p || s[field] == null || p[field] == null) return null;
      const dt = (s.timestamp - p.timestamp) / 1000;
      return dt > 0 ? (s[field] - p[field]) / dt : null;
    };
    const delta = (s, field) => {
      const p = this.prev.get(s.id);
      return p && s[field] != null && p[field] != null ? s[field] - p[field] : null;
    };

    let pair = null;
    for (const s of byId.values()) {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId) ?? pair;
    }
    if (!pair) {
      for (const s of byId.values()) if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    }
    const local = pair ? byId.get(pair.localCandidateId) : null;
    const remote = pair ? byId.get(pair.remoteCandidateId) : null;

    const result = {
      rttMs: pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
      availableOutKbps: pair?.availableOutgoingBitrate ? pair.availableOutgoingBitrate / 1000 : null,
      path: local
        ? {
            local: local.candidateType,
            remote: remote?.candidateType ?? '?',
            protocol: local.protocol,
            relay: local.candidateType === 'relay' || remote?.candidateType === 'relay',
            remoteAddr: remote?.address ? `${remote.address}:${remote.port}` : '',
          }
        : null,
      video: null,
      audio: { outKbps: 0, inKbps: 0, inLossPct: null, concealedPct: null },
      lossPct: null,
      quality: 'unknown',
    };

    let audioLost = 0;
    let audioReceived = 0;
    let audioSamples = 0;
    let audioConcealed = 0;
    for (const s of byId.values()) {
      if (s.type === 'outbound-rtp' && s.kind === 'video' && (s.framesEncoded ?? 0) > 0) {
        const ri = [...byId.values()].find((r) => r.type === 'remote-inbound-rtp' && r.localId === s.id);
        const sent = delta(s, 'packetsSent');
        const lost = ri ? delta(ri, 'packetsLost') : null;
        result.video = {
          direction: 'out',
          kbps: (rate(s, 'bytesSent') ?? 0) * 0.008,
          targetKbps: s.targetBitrate ? s.targetBitrate / 1000 : null,
          fps: s.framesPerSecond ?? 0,
          width: s.frameWidth ?? 0,
          height: s.frameHeight ?? 0,
          codec: codecName(byId, s.codecId),
          impl: s.encoderImplementation ?? '',
          hw: encoderIsHardware(s),
          limitation: s.qualityLimitationReason ?? 'none',
          lossPct: sent && lost != null ? Math.max(0, (lost / sent) * 100) : ri?.fractionLost != null ? ri.fractionLost * 100 : null,
          nack: s.nackCount ?? 0,
          pli: s.pliCount ?? 0,
        };
      } else if (s.type === 'inbound-rtp' && s.kind === 'video' && (s.framesDecoded ?? 0) > 0) {
        const received = delta(s, 'packetsReceived');
        const lost = delta(s, 'packetsLost');
        const emitted = delta(s, 'jitterBufferEmittedCount');
        result.video = {
          direction: 'in',
          kbps: (rate(s, 'bytesReceived') ?? 0) * 0.008,
          fps: s.framesPerSecond ?? 0,
          width: s.frameWidth ?? 0,
          height: s.frameHeight ?? 0,
          codec: codecName(byId, s.codecId),
          impl: s.decoderImplementation ?? '',
          hw: decoderIsHardware(s),
          lossPct: received != null && lost != null && received + lost > 0 ? Math.max(0, (lost / (received + lost)) * 100) : null,
          jitterMs: s.jitter != null ? s.jitter * 1000 : null,
          bufferMs: emitted ? (delta(s, 'jitterBufferDelay') / emitted) * 1000 : null,
          dropped: s.framesDropped ?? 0,
          freezes: s.freezeCount ?? 0,
        };
      } else if (s.type === 'outbound-rtp' && s.kind === 'audio') {
        result.audio.outKbps += (rate(s, 'bytesSent') ?? 0) * 0.008;
      } else if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        result.audio.inKbps += (rate(s, 'bytesReceived') ?? 0) * 0.008;
        audioLost += Math.max(0, delta(s, 'packetsLost') ?? 0);
        audioReceived += delta(s, 'packetsReceived') ?? 0;
        // Досочинённые приёмником отсчёты (пакет не пришёл вовремя): их много — в звуке треск и щелчки
        audioSamples += delta(s, 'totalSamplesReceived') ?? 0;
        audioConcealed += Math.max(0, (delta(s, 'concealedSamples') ?? 0) - (delta(s, 'silentConcealedSamples') ?? 0));
      }
    }
    if (audioReceived + audioLost > 0) result.audio.inLossPct = (audioLost / (audioReceived + audioLost)) * 100;
    if (audioSamples > 0) result.audio.concealedPct = (audioConcealed / audioSamples) * 100;

    result.lossPct = result.video?.lossPct ?? result.audio.inLossPct;
    result.quality = evaluate(result);

    this.prev = byId;
    return result;
  }
}

function evaluate(s) {
  const loss = s.lossPct;
  const rtt = s.rttMs;
  if (loss == null && rtt == null) return 'unknown';
  if ((loss ?? 0) >= 5 || (rtt ?? 0) >= 200) return 'poor';
  if ((loss ?? 0) >= 1 || (rtt ?? 0) >= 100 || ['bandwidth', 'cpu'].includes(s.video?.limitation)) return 'fair';
  return 'good';
}

export function formatKbps(kbps) {
  if (kbps == null) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Мбит/с` : `${Math.round(kbps)} кбит/с`;
}

const CANDIDATE = { host: 'host', srflx: 'srflx', prflx: 'prflx', relay: 'TURN' };
const LIMITATION = { none: 'нет', bandwidth: 'ширина канала', cpu: 'процессор/энкодер', other: 'другое' };

export function formatPath(path) {
  if (!path) return '—';
  const kind = path.relay ? 'через TURN-релей' : 'P2P напрямую';
  return `${kind} · ${CANDIDATE[path.local] ?? path.local} ↔ ${CANDIDATE[path.remote] ?? path.remote} · ${String(path.protocol).toUpperCase()}`;
}

/**
 * Диагностика, пока P2P не установлено: дошли ли сигналы, какие кандидаты есть с обеих сторон
 * и проходят ли проверки связности (STUN-запросы ICE).
 */
export async function describeIce(session) {
  const { pc, diag } = session;
  const report = await pc.getStats();
  const local = [];
  const pairs = {};
  let sent = 0;
  let responses = 0;
  let incoming = 0;
  report.forEach((s) => {
    if (s.type === 'local-candidate') {
      local.push(`${s.candidateType} ${s.address ?? '?'}:${s.port}${s.protocol === 'tcp' ? '/tcp' : ''}`);
    } else if (s.type === 'candidate-pair') {
      pairs[s.state] = (pairs[s.state] ?? 0) + 1;
      sent += s.requestsSent ?? 0;
      responses += s.responsesReceived ?? 0;
      incoming += s.requestsReceived ?? 0;
    }
  });
  const list = (items) => [...new Set(items)].join(', ') || 'нет';
  const rows = [
    ['Ответ собеседника (SDP)', pc.remoteDescription ? 'получен' : 'не получен — сигналы WebRTC не доходят'],
    ['Состояние ICE', `${pc.iceConnectionState}, сбор кандидатов: ${pc.iceGatheringState}`],
    ['Свои кандидаты', `${list(local)} (отправлено собеседнику: ${diag.localSent})`],
  ];
  if (pc.iceGatheringState === 'complete' && !local.some((c) => c.startsWith('srflx'))) {
    const errors = [...diag.stunErrors].join('; ');
    rows.push(['Внешний адрес (STUN)', `не определён — UDP или STUN-серверы недоступны из этой сети${errors ? ` (${errors})` : ''}`]);
  }
  rows.push(
    ['Кандидаты собеседника', diag.remote.size ? [...diag.remote.keys()].join(', ') : 'не получено ни одного'],
    ...(diag.rejected.length ? [['Отклонены', diag.rejected.slice(-4).join('; ')]] : []),
    ['Пары кандидатов', Object.entries(pairs).map(([k, v]) => `${k}: ${v}`).join(', ') || 'нет'],
    ['Проверки связности', `отправлено ${sent}, ответов ${responses}, входящих ${incoming}`],
    ['Журнал', diag.events.slice(-8).join(' · ') || '—'],
  );
  return rows;
}

/** Строки для подробной панели статистики */
export function describeStats(s, extra = {}) {
  const lines = [];
  lines.push(['Путь', formatPath(s.path)]);
  lines.push(['Пинг (RTT)', s.rttMs != null ? `${Math.round(s.rttMs)} мс` : '—']);
  lines.push(['Потери пакетов', s.lossPct != null ? `${s.lossPct.toFixed(2)} %` : '—']);
  if (s.availableOutKbps) lines.push(['Оценка канала ↑', formatKbps(s.availableOutKbps)]);
  const v = s.video;
  if (v) {
    const arrow = v.direction === 'out' ? '↑' : '↓';
    const hw = v.hw === true ? 'аппаратно' : v.hw === false ? 'программно (CPU)' : 'нет данных';
    lines.push([`Видео ${arrow}`, `${v.codec ?? '?'} · ${hw}${v.impl ? ` · ${v.impl}` : ''}`]);
    lines.push(['Кадр', `${v.width}×${v.height} @ ${Math.round(v.fps)} к/с`]);
    lines.push(['Битрейт видео', `${formatKbps(v.kbps)}${v.targetKbps ? ` (цель ${formatKbps(v.targetKbps)})` : ''}`]);
    if (v.direction === 'out') lines.push(['Ограничение качества', LIMITATION[v.limitation] ?? v.limitation]);
    if (v.direction === 'in') {
      if (v.jitterMs != null) lines.push(['Джиттер', `${v.jitterMs.toFixed(1)} мс`]);
      if (v.bufferMs != null) lines.push(['Джиттер-буфер', `${Math.round(v.bufferMs)} мс`]);
      lines.push(['Пропущено кадров / фризов', `${v.dropped} / ${v.freezes}`]);
    }
  }
  const concealed = s.audio.concealedPct;
  lines.push([
    'Звук ↑ / ↓',
    `${formatKbps(s.audio.outKbps)} / ${formatKbps(s.audio.inKbps)}` +
      (concealed >= 0.5 ? ` · досочинено ${concealed.toFixed(1)}% (треск: пакеты опаздывают или не успевает процессор)` : ''),
  ]);
  for (const [k, val] of Object.entries(extra)) lines.push([k, val]);
  return lines;
}
