// WebRTC-сессия между стримером и зрителем.
//
// m-секции (их создаёт стример, offerer):
//   0 — голос, Opus, sendrecv (микрофоны обоих с шумодавом)
//   1 — видео экрана, sendonly (AV1/H264/VP9)
//   2 — системный звук, Opus стерео, sendonly
// Треки подставляются через replaceTrack, поэтому начало/остановка трансляции и смена
// микрофона не требуют пересогласования. Пересогласование нужно только для смены кодека
// и ICE restart; его всегда начинает стример, так что «гонки офферов» не бывает.
import { mungeRemoteSdp, MLINE } from './sdp.js';
import { applyCodecPreferences } from './codecs.js';

const DISCONNECT_GRACE_MS = 4000;
const MAX_ICE_RESTARTS = 5;
// Приоритет синтетического srflx-кандидата: type preference 100, local preference 65535, компонент 1
const FORWARDED_PRIORITY = 100 * 2 ** 24 + 65535 * 2 ** 8 + 255;

export function buildRtcConfig(network) {
  const iceServers = network.iceServers.map((s) => ({ ...s }));
  if (network.turn.enabled && network.turn.urls) {
    iceServers.push({ urls: network.turn.urls, username: network.turn.username, credential: network.turn.credential });
  }
  return {
    iceServers,
    iceTransportPolicy: network.forceRelay ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  };
}

async function updateEncoding(sender, fields, degradationPreference) {
  const apply = async (withDegradation) => {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    Object.assign(params.encodings[0], fields);
    if (withDegradation && degradationPreference) params.degradationPreference = degradationPreference;
    await sender.setParameters(params);
  };
  try {
    await apply(true);
  } catch (err) {
    try {
      await apply(false);
    } catch {
      console.warn('[rtp] setParameters:', err.message);
    }
  }
}

export class PeerSession extends EventTarget {
  /**
   * @param {{role:'streamer'|'viewer', sid?:string, cfg:object, send:(msg:object)=>Promise<unknown>, micTrack:MediaStreamTrack|null}} options
   */
  constructor({ role, sid, cfg, send, micTrack }) {
    super();
    this.role = role;
    this.sid = sid ?? crypto.randomUUID();
    this.cfg = cfg;
    this.sendRaw = send;
    this.micTrack = micTrack;
    this.screenStream = null;
    this.maxFrameArea = 0;
    this.codecOrder = [];
    this.triedCodecs = new Set();
    this.hwSearchDone = false;

    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    this.makingOffer = false;
    this.renegotiate = null; // { iceRestart } — отложенное пересогласование
    this.iceRestarts = 0;
    this.closed = false;
    this.paramsChain = Promise.resolve();

    // Для синтеза кандидатов «белый IP : проброшенный порт»
    this.publicIps = new Set(cfg.network.publicIp ? [cfg.network.publicIp] : []);
    this.hostCandidates = [];
    this.announced = new Set();
    this.forwardedCount = 0;

    this.pc = new RTCPeerConnection(buildRtcConfig(cfg.network));
    this.pc.onicecandidate = (e) => this.onLocalCandidate(e.candidate);
    this.pc.ontrack = (e) => this.onTrack(e);
    this.pc.onconnectionstatechange = () => this.onConnectionState();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  send(msg) {
    if (this.closed) return Promise.resolve(false);
    return this.sendRaw({ ...msg, sid: this.sid });
  }

  // ---------------- стример ----------------

  async startAsStreamer({ codecOrder, screenStream, scaleDownBy = 1 }) {
    const v = this.cfg.video;
    this.codecOrder = codecOrder;
    this.voiceT = this.pc.addTransceiver(this.micTrack ?? 'audio', { direction: 'sendrecv' });
    this.videoT = this.pc.addTransceiver('video', {
      direction: 'sendonly',
      sendEncodings: [{ maxBitrate: v.bitrateKbps * 1000, maxFramerate: v.frameRate, priority: 'high', networkPriority: 'high' }],
    });
    this.systemT = this.pc.addTransceiver('audio', { direction: 'sendonly' });
    applyCodecPreferences(this.videoT, codecOrder);
    if (screenStream) await this.setScreen(screenStream, { scaleDownBy });
    await this.negotiate();
  }

  async negotiate({ iceRestart = false } = {}) {
    if (this.closed) return;
    if (this.makingOffer || this.pc.signalingState !== 'stable') {
      this.renegotiate = { iceRestart: iceRestart || Boolean(this.renegotiate?.iceRestart) };
      return;
    }
    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer({ iceRestart });
      await this.pc.setLocalDescription(offer);
      await this.send({
        kind: 'offer',
        sdp: this.pc.localDescription.sdp,
        codecOrder: this.codecOrder,
        live: Boolean(this.screenStream),
      });
    } finally {
      this.makingOffer = false;
    }
  }

  async handleAnswer(msg) {
    if (this.pc.signalingState !== 'have-local-offer') return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp: mungeRemoteSdp(msg.sdp, this.cfg, { sendsVideo: true }) });
    this.remoteDescriptionSet = true;
    await this.flushCandidates();
    await this.applySenderParams();
    if (this.renegotiate) {
      const next = this.renegotiate;
      this.renegotiate = null;
      await this.negotiate(next);
    }
  }

  /**
   * Chromium не умеет «растить» уже созданный аппаратный энкодер: если кадр становится больше,
   * чем был (окно → весь экран), WebRTC молча переходит на программный libaom/OpenH264.
   * В таком случае сессию надо пересоздать — новая PeerConnection создаст новый энкодер.
   */
  /** @param {number} area площадь кадра нового источника после масштабирования */
  wouldGrowFrame(area) {
    return this.maxFrameArea > 0 && area > this.maxFrameArea;
  }

  /** Фактический размер закодированного кадра (из статистики; getSettings() у окон врёт). */
  noteEncodedFrame(width, height) {
    this.maxFrameArea = Math.max(this.maxFrameArea, width * height);
  }

  /**
   * Подставляет захват экрана (или null) в видеосендер и сендер системного звука.
   * scaleDownBy — во сколько раз уменьшать кадр перед кодированием (собственный захват отдаёт
   * исходный размер, а захват Chromium уже уменьшен ограничениями getDisplayMedia).
   */
  async setScreen(stream, { scaleDownBy = 1 } = {}) {
    this.screenStream = stream;
    this.scaleDownBy = scaleDownBy;
    await this.videoT?.sender.replaceTrack(stream?.getVideoTracks()[0] ?? null);
    await this.systemT?.sender.replaceTrack(stream?.getAudioTracks()[0] ?? null);
    await this.applySenderParams();
  }

  /** Смена порядка кодеков (например, AV1 оказался программным) — новый offer. */
  async switchCodecs(order) {
    this.codecOrder = order;
    applyCodecPreferences(this.videoT, order);
    await this.negotiate();
  }

  // ---------------- зритель ----------------

  async handleOffer(msg) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: mungeRemoteSdp(msg.sdp, this.cfg, { sendsVideo: false }) });
    this.remoteDescriptionSet = true;
    await this.flushCandidates();

    const transceivers = this.pc.getTransceivers();
    this.voiceT = transceivers[MLINE.VOICE];
    this.videoT = transceivers[MLINE.VIDEO];
    this.systemT = transceivers[MLINE.SYSTEM];
    if (this.voiceT) {
      this.voiceT.direction = 'sendrecv';
      if (this.voiceT.sender.track !== this.micTrack) await this.voiceT.sender.replaceTrack(this.micTrack);
    }
    if (this.videoT) {
      this.videoT.direction = 'recvonly';
      this.codecOrder = msg.codecOrder ?? [];
      applyCodecPreferences(this.videoT, this.codecOrder);
    }
    if (this.systemT) this.systemT.direction = 'recvonly';

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.send({ kind: 'answer', sdp: this.pc.localDescription.sdp });
    await this.applySenderParams();
    this.tuneReceivers();
  }

  tuneReceivers() {
    const target = this.cfg.playback.jitterBufferTargetMs;
    if (!target) return;
    for (const receiver of this.pc.getReceivers()) {
      if (receiver.track?.kind === 'video' && 'jitterBufferTarget' in receiver) receiver.jitterBufferTarget = target;
    }
  }

  // ---------------- общее ----------------

  async setMicTrack(track) {
    this.micTrack = track;
    if (this.voiceT && this.voiceT.sender.track !== track) await this.voiceT.sender.replaceTrack(track);
  }

  updateConfig(cfg) {
    this.cfg = cfg;
    return this.applySenderParams();
  }

  setScale(scaleDownBy) {
    this.scaleDownBy = scaleDownBy;
    return this.applySenderParams();
  }

  /** Битрейт/FPS/приоритеты сендеров. Вызовы выстраиваются в очередь — setParameters не любит параллельности. */
  applySenderParams() {
    this.paramsChain = this.paramsChain
      .then(async () => {
        if (this.closed) return;
        const { video: v, audio: a } = this.cfg;
        if (this.voiceT?.sender.track) {
          await updateEncoding(this.voiceT.sender, {
            maxBitrate: a.voiceBitrateKbps * 1000,
            priority: 'high',
            networkPriority: 'high',
          });
        }
        if (this.role === 'streamer' && this.videoT) {
          await updateEncoding(
            this.videoT.sender,
            {
              maxBitrate: v.bitrateKbps * 1000,
              maxFramerate: v.frameRate,
              scaleResolutionDownBy: this.scaleDownBy ?? 1,
              priority: 'high',
              networkPriority: 'high',
            },
            v.degradationPreference,
          );
        }
        if (this.role === 'streamer' && this.systemT?.sender.track) {
          await updateEncoding(this.systemT.sender, { maxBitrate: a.systemAudioBitrateKbps * 1000 });
        }
      })
      .catch((err) => console.warn('[rtp]', err));
    return this.paramsChain;
  }

  async addRemoteCandidate(init) {
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(init);
      return;
    }
    try {
      await this.pc.addIceCandidate(init);
    } catch (err) {
      console.warn('[ice] кандидат отклонён:', init?.candidate, err.message);
    }
  }

  async flushCandidates() {
    const list = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of list) await this.addRemoteCandidate(c);
  }

  onLocalCandidate(candidate) {
    if (!candidate) {
      this.send({ kind: 'end-of-candidates' });
      return;
    }
    if (!candidate.candidate) return;
    this.announced.add(`${candidate.address}:${candidate.port}:${candidate.usernameFragment}`);
    this.send({ kind: 'candidate', candidate: candidate.toJSON() });
    if (this.role === 'streamer') this.announceForwardedPorts(candidate);
  }

  /**
   * Проброс портов. На роутере стримера диапазон UDP network.udpPortRange проброшен на этот ПК,
   * и WebRTC ограничен тем же диапазоном (main.js → setWebRTCUDPPortRange). Значит, порт
   * host-кандидата доступен снаружи как <белый IP>:<тот же порт>. Chromium об этом не знает,
   * поэтому такой кандидат собираем сами. Белый IP берём из конфига или из srflx-кандидата (STUN).
   * Так зритель за любым NAT (включая симметричный CGNAT) достучится до стримера напрямую.
   */
  announceForwardedPorts(c) {
    const { min, max } = this.cfg.network.udpPortRange;
    if (!min || c.protocol !== 'udp' || !c.address || c.address.includes(':') || c.address.endsWith('.local')) return;
    if (c.type === 'host') this.hostCandidates.push(c);
    else if (c.type === 'srflx') this.publicIps.add(c.address);
    else return;

    for (const ip of this.publicIps) {
      for (const host of this.hostCandidates) {
        if (host.port < min || host.port > max || host.address === ip) continue;
        const key = `${ip}:${host.port}:${host.usernameFragment}`;
        if (this.announced.has(key)) continue;
        this.announced.add(key);
        const line =
          `candidate:duo${++this.forwardedCount} 1 udp ${FORWARDED_PRIORITY} ${ip} ${host.port} ` +
          `typ srflx raddr ${host.address} rport ${host.port} generation 0 ufrag ${host.usernameFragment}`;
        this.send({
          kind: 'candidate',
          candidate: { candidate: line, sdpMid: host.sdpMid, sdpMLineIndex: host.sdpMLineIndex, usernameFragment: host.usernameFragment },
        });
        this.emit('forwarded-candidate', { ip, port: host.port });
      }
    }
  }

  onTrack(event) {
    const index = this.pc.getTransceivers().indexOf(event.transceiver);
    const kind = index === MLINE.VIDEO ? 'video' : index === MLINE.SYSTEM ? 'system' : 'voice';
    this.emit('track', { kind, track: event.track, stream: new MediaStream([event.track]) });
  }

  onConnectionState() {
    const state = this.pc.connectionState;
    clearTimeout(this.disconnectTimer);
    if (state === 'connected') this.iceRestarts = 0;
    if (state === 'disconnected') this.disconnectTimer = setTimeout(() => this.recover(), DISCONNECT_GRACE_MS);
    if (state === 'failed') this.recover();
    this.emit('state', { state });
  }

  /**
   * Восстановление после обрыва: стример делает ICE restart, зритель просит его об этом.
   * force — запрос пришёл от зрителя: у стримера соединение может ещё числиться живым.
   */
  recover({ force = false } = {}) {
    if (this.closed || (!force && this.pc.connectionState === 'connected')) return;
    if (this.role === 'viewer') {
      this.send({ kind: 'restart-request' });
      return;
    }
    if (this.iceRestarts >= MAX_ICE_RESTARTS) {
      this.emit('gave-up');
      return;
    }
    this.iceRestarts++;
    this.negotiate({ iceRestart: true }).catch((err) => console.warn('[ice] restart:', err));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.disconnectTimer);
    this.pc.close();
    this.emit('state', { state: 'closed' });
  }
}
