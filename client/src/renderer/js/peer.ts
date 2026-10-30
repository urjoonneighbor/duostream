// WebRTC-сессия между стримером и зрителем.
//
// m-секции (их создаёт стример, offerer):
//   0 — голос, Opus, sendrecv (микрофоны обоих с шумодавом)
//   1 — видео экрана, sendonly (AV1/H264/VP9)
//   2 — системный звук, Opus стерео, sendonly
// Треки подставляются через replaceTrack, поэтому начало/остановка трансляции и смена
// микрофона не требуют пересогласования. Пересогласование нужно только для смены кодека
// и ICE restart; его всегда начинает стример, так что «гонки офферов» не бывает.
import { mungeRemoteSdp, MLINE } from './sdp.ts';
import { applyCodecPreferences } from './codecs.ts';
import { Emitter } from './events.ts';
import type { CodecName, Config, DegradationPreference, Role } from '../../shared/config';
import type { Signal } from './signaling.ts';

/** Диапазон портов, проброшенных на роутере стримера */
export interface PortRange {
  min: number;
  max: number;
}

/** offer от стримера (сигнал kind: 'offer') */
export interface OfferSignal {
  kind: 'offer';
  sdp: string;
  codecOrder?: CodecName[];
  live?: boolean;
  forwardRange?: PortRange | null;
}

export interface CandidateInfo {
  protocol: string;
  address: string;
  port: number;
  type: string;
}

export type TrackKind = 'voice' | 'video' | 'system';

export interface PeerEvents {
  datachannels: { chat: RTCDataChannel; file: RTCDataChannel };
  track: { kind: TrackKind; track: MediaStreamTrack; stream: MediaStream };
  state: { state: RTCPeerConnectionState };
  'forwarded-candidate': { ip: string; port: number };
  'gave-up': undefined;
}

/** Диагностика ICE, не зависящая от статистики Chromium (она удаляет кандидатов после неудачи) */
export interface IceDiag {
  localSent: number;
  remote: Map<string, CandidateInfo | null>;
  rejected: string[];
  stunErrors: Set<string>;
  events: string[];
}

type EncodingFields = Partial<RTCRtpEncodingParameters> & { networkPriority?: RTCPriorityType; priority?: RTCPriorityType };

const DISCONNECT_GRACE_MS = 4000;
const MAX_ICE_RESTARTS = 5;
// Приоритет синтетического srflx-кандидата: type preference 100, local preference 65535, компонент 1
const FORWARDED_PRIORITY = 100 * 2 ** 24 + 65535 * 2 ** 8 + 255;

export function buildRtcConfig(network: Config['network']): RTCConfiguration {
  const iceServers: RTCIceServer[] = network.iceServers.map((s) => ({ ...s }));
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

async function updateEncoding(sender: RTCRtpSender, fields: EncodingFields, degradationPreference?: DegradationPreference): Promise<void> {
  const apply = async (withDegradation: boolean) => {
    const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: DegradationPreference };
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
      console.warn('[rtp] setParameters:', (err as Error).message);
    }
  }
}

/** «candidate:F 1 udp PRIO ADDR PORT typ TYPE …» → {protocol, address, port, type} */
export function parseCandidate(line: unknown): CandidateInfo | null {
  const p = String(line ?? '').replace(/^a=/, '').split(' ');
  if (p.length < 8 || p[6] !== 'typ') return null;
  return { protocol: p[2].toLowerCase(), address: p[4], port: Number(p[5]), type: p[7] };
}

const describeCandidate = (c: CandidateInfo) => `${c.type} ${c.address}:${c.port}${c.protocol === 'tcp' ? '/tcp' : ''}`;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export class PeerSession extends Emitter<PeerEvents> {
  readonly role: Role;
  /** Хост сигнального сервера из адреса подключения (у зрителя это белый IP стримера) */
  private readonly serverHost: string;
  private forwardRange: PortRange | null = null; // диапазон проброшенных портов стримера (приходит в offer)
  private readonly forwardedRemote = new Set<string>();
  private readonly startedAt = performance.now();
  readonly diag: IceDiag = { localSent: 0, remote: new Map(), rejected: [], stunErrors: new Set(), events: [] };
  readonly sid: string;
  cfg: Config;
  private readonly sendRaw: (msg: Signal) => Promise<boolean>;
  private micTrack: MediaStreamTrack | null;
  screenStream: MediaStream | null = null;
  private scaleDownBy = 1;
  maxFrameArea = 0;
  codecOrder: CodecName[] = [];
  /** Кодеки, которые уже пробовали при поиске аппаратного энкодера (app.ts → checkEncoder) */
  readonly triedCodecs = new Set<CodecName>();
  hwSearchDone = false;

  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private makingOffer = false;
  private renegotiate: { iceRestart: boolean } | null = null; // отложенное пересогласование
  private iceRestarts = 0;
  closed = false;
  private paramsChain: Promise<void> = Promise.resolve();
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;

  // Для синтеза кандидатов «белый IP : проброшенный порт»
  private readonly publicIps: Set<string>;
  private readonly hostCandidates: RTCIceCandidate[] = [];
  private readonly announced = new Set<string>();
  private forwardedCount = 0;

  readonly pc: RTCPeerConnection;
  voiceT: RTCRtpTransceiver | null = null;
  videoT: RTCRtpTransceiver | null = null;
  systemT: RTCRtpTransceiver | null = null;
  chatChannel: RTCDataChannel | null = null;
  fileChannel: RTCDataChannel | null = null;

  constructor({
    role,
    sid,
    cfg,
    send,
    micTrack,
    serverHost = '',
    publicIp = null,
  }: {
    role: Role;
    sid?: string;
    cfg: Config;
    send: (msg: Signal) => Promise<boolean>;
    micTrack: MediaStreamTrack | null;
    serverHost?: string;
    publicIp?: string | null;
  }) {
    super();
    this.role = role;
    this.serverHost = serverHost;
    this.sid = sid ?? crypto.randomUUID();
    this.cfg = cfg;
    this.sendRaw = send;
    this.micTrack = micTrack;
    this.publicIps = new Set([cfg.network.publicIp, publicIp].filter((ip): ip is string => Boolean(ip)));

    this.pc = new RTCPeerConnection(buildRtcConfig(cfg.network));
    this.pc.onicecandidate = (e) => this.onLocalCandidate(e.candidate);
    this.pc.ontrack = (e) => this.onTrack(e);
    this.pc.onconnectionstatechange = () => this.onConnectionState();
    this.pc.oniceconnectionstatechange = () => this.logEvent(`ICE ${this.pc.iceConnectionState}`);
    this.pc.onicegatheringstatechange = () => this.logEvent(`сбор ${this.pc.iceGatheringState}`);
    // Ошибки STUN/TURN: почему не определился внешний адрес
    this.pc.onicecandidateerror = (e: RTCPeerConnectionIceErrorEvent) => {
      if (this.diag.stunErrors.size < 6) this.diag.stunErrors.add(`${e.url}: ${e.errorCode} ${e.errorText}`.trim());
    };
  }

  logEvent(text: string): void {
    const t = ((performance.now() - this.startedAt) / 1000).toFixed(0);
    this.diag.events.push(`${t} с: ${text}`);
    console.log(`[ice] ${text}`);
    if (this.diag.events.length > 14) this.diag.events.shift();
  }

  send(msg: Signal): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return this.sendRaw({ ...msg, sid: this.sid });
  }

  // ---------------- стример ----------------

  async startAsStreamer({
    codecOrder,
    screenStream,
    scaleDownBy = 1,
  }: {
    codecOrder: CodecName[];
    screenStream: MediaStream | null;
    scaleDownBy?: number;
  }): Promise<void> {
    const v = this.cfg.video;
    this.codecOrder = codecOrder;
    this.voiceT = this.pc.addTransceiver(this.micTrack ?? 'audio', { direction: 'sendrecv' });
    this.videoT = this.pc.addTransceiver('video', {
      direction: 'sendonly',
      sendEncodings: [{ maxBitrate: v.bitrateKbps * 1000, maxFramerate: v.frameRate, priority: 'high', networkPriority: 'high' }],
    });
    this.systemT = this.pc.addTransceiver('audio', { direction: 'sendonly' });
    this.openDataChannels(); // после трансиверов: m=application — четвёртая секция, MLINE не сдвигается
    applyCodecPreferences(this.videoT, codecOrder);
    if (screenStream) await this.setScreen(screenStream, { scaleDownBy });
    await this.negotiate();
  }

  async negotiate({ iceRestart = false } = {}): Promise<void> {
    if (this.closed) return;
    if (this.makingOffer || this.pc.signalingState !== 'stable') {
      this.renegotiate = { iceRestart: iceRestart || Boolean(this.renegotiate?.iceRestart) };
      return;
    }
    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer({ iceRestart });
      await this.pc.setLocalDescription(offer);
      this.logEvent(iceRestart ? 'ICE restart, offer отправлен' : 'offer отправлен');
      const { min, max } = this.cfg.network.udpPortRange;
      await this.send({
        kind: 'offer',
        sdp: this.pc.localDescription!.sdp,
        codecOrder: this.codecOrder,
        live: Boolean(this.screenStream),
        // Зрителю: эти порты проброшены на роутере — см. addForwardedRemote
        forwardRange: min ? { min, max } : null,
      });
    } finally {
      this.makingOffer = false;
    }
  }

  async handleAnswer(msg: { sdp: string }): Promise<void> {
    if (this.pc.signalingState !== 'have-local-offer') return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp: mungeRemoteSdp(msg.sdp, this.cfg, { sendsVideo: true }) });
    this.logEvent('answer получен');
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
  /** @param area площадь кадра нового источника после масштабирования */
  wouldGrowFrame(area: number): boolean {
    return this.maxFrameArea > 0 && area > this.maxFrameArea;
  }

  /**
   * Новый видеоэнкодер без пересогласования: выключить кодирование (active=false) и включить снова.
   * WebRTC при этом освобождает энкодер и создаёт его под текущий размер кадра.
   */
  async resetVideoEncoder(): Promise<void> {
    const sender = this.videoT?.sender;
    if (!sender) return;
    const toggle = async (active: boolean) => {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      for (const e of params.encodings) e.active = active;
      await sender.setParameters(params);
    };
    await (this.paramsChain = this.paramsChain.then(() => toggle(false)).catch(() => {}));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await (this.paramsChain = this.paramsChain.then(() => toggle(true)).catch(() => {}));
    this.logEvent('видеоэнкодер пересоздан');
  }

  /** Фактический размер закодированного кадра (из статистики; getSettings() у окон врёт). */
  noteEncodedFrame(width: number, height: number): void {
    this.maxFrameArea = Math.max(this.maxFrameArea, width * height);
  }

  /**
   * Подставляет захват экрана (или null) в видеосендер и сендер системного звука.
   * scaleDownBy — во сколько раз уменьшать кадр перед кодированием (собственный захват отдаёт
   * исходный размер, а захват Chromium уже уменьшен ограничениями getDisplayMedia).
   */
  async setScreen(stream: MediaStream | null, { scaleDownBy = 1 } = {}): Promise<void> {
    this.screenStream = stream;
    this.scaleDownBy = scaleDownBy;
    await this.videoT?.sender.replaceTrack(stream?.getVideoTracks()[0] ?? null);
    await this.systemT?.sender.replaceTrack(stream?.getAudioTracks()[0] ?? null);
    await this.applySenderParams();
  }

  /** Смена порядка кодеков (например, AV1 оказался программным) — новый offer. */
  async switchCodecs(order: CodecName[]): Promise<void> {
    this.codecOrder = order;
    applyCodecPreferences(this.videoT, order);
    await this.negotiate();
  }

  // ---------------- зритель ----------------

  async handleOffer(msg: OfferSignal): Promise<void> {
    this.forwardRange = msg.forwardRange ?? null;
    if (!this.chatChannel) this.openDataChannels();
    await this.pc.setRemoteDescription({ type: 'offer', sdp: mungeRemoteSdp(msg.sdp, this.cfg, { sendsVideo: false }) });
    this.logEvent('offer получен');
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
    await this.send({ kind: 'answer', sdp: this.pc.localDescription!.sdp });
    await this.applySenderParams();
    this.tuneReceivers();
  }

  /**
   * Запас буфера трансляции (playback.streamBufferMs): видео и звуку трансляции одинаковый, иначе звук
   * разойдётся с картинкой (дорожки не синхронизированы). Голос — без запаса, чтобы разговор не запаздывал.
   */
  private tuneReceivers(): void {
    const target = this.cfg.playback.streamBufferMs ?? 0;
    for (const t of [this.videoT, this.systemT]) {
      const receiver = t?.receiver;
      if (receiver && 'jitterBufferTarget' in receiver) receiver.jitterBufferTarget = target || null;
    }
  }

  // ---------------- общее ----------------

  /**
   * Каналы чата (js/chat.ts): сообщения и куски файлов. negotiated — номера каналов заданы заранее
   * у обеих сторон, отдельное согласование не нужно.
   */
  private openDataChannels(): void {
    const chat = this.pc.createDataChannel('chat', { negotiated: true, id: 1, ordered: true });
    const file = this.pc.createDataChannel('file', { negotiated: true, id: 2, ordered: true });
    file.binaryType = 'arraybuffer';
    Object.assign(this, { chatChannel: chat, fileChannel: file });
    this.emit('datachannels', { chat, file });
  }

  async setMicTrack(track: MediaStreamTrack | null): Promise<void> {
    this.micTrack = track;
    if (this.voiceT && this.voiceT.sender.track !== track) await this.voiceT.sender.replaceTrack(track);
  }

  updateConfig(cfg: Config): Promise<void> {
    this.cfg = cfg;
    return this.applySenderParams();
  }

  setScale(scaleDownBy: number): Promise<void> {
    this.scaleDownBy = scaleDownBy;
    return this.applySenderParams();
  }

  /** Битрейт/FPS/приоритеты сендеров. Вызовы выстраиваются в очередь — setParameters не любит параллельности. */
  applySenderParams(): Promise<void> {
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

  async addRemoteCandidate(init: RTCIceCandidateInit): Promise<void> {
    const info = parseCandidate(init?.candidate);
    if (info) this.diag.remote.set(describeCandidate(info), info);
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(init);
      return;
    }
    try {
      await this.pc.addIceCandidate(init);
    } catch (err) {
      this.diag.rejected.push(`${info ? describeCandidate(info) : init?.candidate}: ${(err as Error).message}`);
      console.warn('[ice] кандидат отклонён:', init?.candidate, (err as Error).message);
      return;
    }
    if (this.role === 'viewer' && info) await this.addForwardedRemote(info, init);
  }

  /**
   * Зритель: белый IP стримера — это адрес, по которому мы подключились к сигнальному серверу
   * (сервер работает на ПК стримера за тем же пробросом портов). Поэтому для каждого host-кандидата
   * стримера из проброшенного диапазона добавляем «адрес сервера : тот же порт». Это работает,
   * даже если STUN стримера вернул чужой адрес (например, выход VPN) или не ответил вовсе.
   */
  private async addForwardedRemote(info: CandidateInfo, init: RTCIceCandidateInit): Promise<void> {
    const host = this.serverHost;
    const range = this.forwardRange;
    if (!range?.min || info.type !== 'host' || info.protocol !== 'udp') return;
    if (!IPV4.test(host) || host.startsWith('127.') || host === info.address) return;
    if (info.port < range.min || info.port > range.max) return;
    const ufrag = init.usernameFragment ?? /ufrag (\S+)/.exec(init.candidate ?? '')?.[1];
    const key = `${host}:${info.port}:${ufrag ?? ''}`;
    if (this.forwardedRemote.has(key)) return;
    this.forwardedRemote.add(key);
    const line =
      `candidate:duov${this.forwardedRemote.size} 1 udp ${FORWARDED_PRIORITY} ${host} ${info.port} ` +
      `typ srflx raddr ${info.address} rport ${info.port} generation 0${ufrag ? ` ufrag ${ufrag}` : ''}`;
    try {
      await this.pc.addIceCandidate({ candidate: line, sdpMid: init.sdpMid, sdpMLineIndex: init.sdpMLineIndex, usernameFragment: ufrag });
      const parsed = parseCandidate(line)!;
      this.diag.remote.set(`${describeCandidate(parsed)} (адрес сервера)`, parsed);
    } catch (err) {
      this.diag.rejected.push(`${host}:${info.port}: ${(err as Error).message}`);
    }
  }

  private async flushCandidates(): Promise<void> {
    const list = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of list) await this.addRemoteCandidate(c);
  }

  private onLocalCandidate(candidate: RTCIceCandidate | null): void {
    if (!candidate) {
      void this.send({ kind: 'end-of-candidates' });
      return;
    }
    if (!candidate.candidate) return;
    this.diag.localSent++;
    this.announced.add(`${candidate.address}:${candidate.port}:${candidate.usernameFragment}`);
    void this.send({ kind: 'candidate', candidate: candidate.toJSON() });
    if (this.role === 'streamer') this.announceForwardedPorts(candidate);
  }

  /**
   * Проброс портов. На роутере стримера диапазон UDP network.udpPortRange проброшен на этот ПК,
   * и WebRTC ограничен тем же диапазоном (main.ts → setWebRTCUDPPortRange). Значит, порт
   * host-кандидата доступен снаружи как <белый IP>:<тот же порт>. Chromium об этом не знает,
   * поэтому такой кандидат собираем сами. Белый IP берём из конфига или из srflx-кандидата (STUN).
   * Так зритель за любым NAT (включая симметричный CGNAT) достучится до стримера напрямую.
   */
  private announceForwardedPorts(c: RTCIceCandidate): void {
    const { min } = this.cfg.network.udpPortRange;
    if (!min || c.protocol !== 'udp' || !c.address || c.address.includes(':') || c.address.endsWith('.local')) return;
    if (c.type === 'host') this.hostCandidates.push(c);
    else if (c.type === 'srflx') this.publicIps.add(c.address);
    else return;
    this.sendForwardedCandidates();
  }

  /** Белый IP стал известен позже (HTTPS-запрос в app.ts) — досылаем кандидаты для уже собранных портов. */
  addPublicIp(ip: string): void {
    if (this.closed || this.publicIps.has(ip)) return;
    this.publicIps.add(ip);
    this.sendForwardedCandidates();
  }

  private sendForwardedCandidates(): void {
    const { min, max } = this.cfg.network.udpPortRange;
    if (!min) return;
    for (const ip of this.publicIps) {
      for (const host of this.hostCandidates) {
        if (host.port === null || host.port < min || host.port > max || host.address === ip) continue;
        const key = `${ip}:${host.port}:${host.usernameFragment}`;
        if (this.announced.has(key)) continue;
        this.announced.add(key);
        const line =
          `candidate:duo${++this.forwardedCount} 1 udp ${FORWARDED_PRIORITY} ${ip} ${host.port} ` +
          `typ srflx raddr ${host.address} rport ${host.port} generation 0 ufrag ${host.usernameFragment}`;
        void this.send({
          kind: 'candidate',
          candidate: { candidate: line, sdpMid: host.sdpMid, sdpMLineIndex: host.sdpMLineIndex, usernameFragment: host.usernameFragment },
        });
        this.emit('forwarded-candidate', { ip, port: host.port });
      }
    }
  }

  /**
   * Уровень голоса собеседника, 0..1 (линейный, 1 = 0 дБ). Берётся из RTP-расширения audio-level,
   * которое заполняет отправитель: не зависит от того, куда и с какой громкостью звук выводится у нас.
   */
  remoteVoiceLevel(): number {
    const source = this.voiceT?.receiver.getSynchronizationSources()[0];
    if (!source || performance.timeOrigin + performance.now() - source.timestamp > 500) return 0;
    return source.audioLevel ?? 0;
  }

  private onTrack(event: RTCTrackEvent): void {
    const index = this.pc.getTransceivers().indexOf(event.transceiver);
    const kind: TrackKind = index === MLINE.VIDEO ? 'video' : index === MLINE.SYSTEM ? 'system' : 'voice';
    this.emit('track', { kind, track: event.track, stream: new MediaStream([event.track]) });
  }

  private onConnectionState(): void {
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
  recover({ force = false } = {}): void {
    if (this.closed || (!force && this.pc.connectionState === 'connected')) return;
    if (this.role === 'viewer') {
      void this.send({ kind: 'restart-request' });
      return;
    }
    if (this.iceRestarts >= MAX_ICE_RESTARTS) {
      this.emit('gave-up', undefined);
      return;
    }
    this.iceRestarts++;
    this.logEvent(`восстановление, попытка ${this.iceRestarts}`);
    this.negotiate({ iceRestart: true }).catch((err) => console.warn('[ice] restart:', err));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.disconnectTimer);
    this.pc.close();
    this.emit('state', { state: 'closed' });
  }
}
