// Главный контроллер интерфейса DuoStream: подключение к серверу, сессия WebRTC,
// захват экрана, микрофон с шумодавом, индикатор качества и настройки.
import { SignalingClient } from './signaling.js';
import { PeerSession } from './peer.js';
import { MicPipeline } from './audio.js';
import { probeVideoCodecs, orderCodecs } from './codecs.js';
import { StatsMonitor, describeStats, describeIce, formatKbps, formatPath } from './stats.js';
import { openSourcePicker } from './picker.js';
import { NativeCaptureTrack, nativeCaptureStatus } from './native-capture.js';
import { SettingsDialog } from './settings.js';
import { $, toast, renderIcons, setIcon, renderList } from './ui.js';

const ROLE_NAME = { streamer: 'Стример', viewer: 'Зритель' };
const FATAL_CODES = new Set(['auth-failed', 'banned', 'replaced', 'bad-version', 'bad-role']);
/** Сколько секунд подряд кодирование должно идти на CPU, прежде чем переключить кодек */
const SW_ENCODER_STRIKES = 5;
/** Пересоздавать сессию из-за ухода энкодера на CPU не чаще, чем раз в 20 с */
const ENCODER_RESTART_COOLDOWN_MS = 20_000;

const state = {
  cfg: null,
  configPath: '',
  role: 'streamer',
  signaling: null,
  sigInfo: '',
  peer: null, // второй участник по данным сервера: {role, name}
  session: null,
  monitor: null,
  stats: null,
  mic: null,
  denoiseErrorShown: false,
  screen: null, // MediaStream захвата экрана (стример)
  capture: null, // {engine:'native'|'chromium', native, width, height, scale}
  hostedServer: null, // встроенный сигнальный сервер стримера: {port, own}
  share: null, // стример: {address} — что передать зрителю
  publicIp: null, // белый IP стримера (настройка, HTTPS или STUN)
  lastPick: null, // последний выбранный источник — для отката на захват Chromium
  nativeStatus: null, // доступен ли собственный захват (src/main/native-capture.js)
  nativeStats: null,
  sourceName: '',
  remoteVideo: null, // MediaStream видео от стримера (зритель)
  remote: { live: false, info: null },
  probe: null,
  codecOrder: [],
  swStrikes: 0,
  lastEncoderRestart: 0, // когда последний раз пересоздавали сессию из-за ухода энкодера на CPU
  pathAnnounced: false,
  hudOpen: false,
  outputs: new Map(), // deviceId → название устройства вывода звука
  voicePeakDb: -Infinity, // максимум уровня голоса собеседника с прошлого тика статистики
  voiceDb: -Infinity, // то же за последнюю завершённую секунду (для окна статистики)
};

// Для отладки в DevTools (F12): duoDebug.session.pc.remoteDescription.sdp и т. п.
globalThis.duoDebug = state;

let settingsDialog;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ======================= подключение =======================

function fillConnectForm() {
  const s = state.cfg.signaling;
  for (const radio of document.querySelectorAll('input[name=role]')) radio.checked = radio.value === s.role;
  $('#fUrl').value = s.url;
  $('#fHostServer').checked = s.hostServer;
  $('#fPort').value = s.serverPort;
  $('#fPassword').value = s.password;
  $('#fName').value = s.displayName;
  updateConnectFields();
}

function selectedRole() {
  return document.querySelector('input[name=role]:checked')?.value ?? 'streamer';
}

/** Стример со встроенным сервером указывает порт, остальные — адрес сервера. */
function hostsServer() {
  return selectedRole() === 'streamer' && $('#fHostServer').checked;
}

function updateConnectFields() {
  const streamer = selectedRole() === 'streamer';
  $('#fHostField').hidden = !streamer;
  $('#fPortField').hidden = !hostsServer();
  $('#fUrlField').hidden = hostsServer();
  updateConnectHint();
}

function updateConnectHint(text, isError = false) {
  const hint = $('#connectHint');
  hint.classList.toggle('error', isError);
  let fallback;
  if (hostsServer()) {
    fallback = 'Сервер запустится в приложении. Пробросьте этот порт на роутере — адрес для зрителя появится после подключения.';
  } else if (selectedRole() === 'streamer') {
    fallback = 'Отдельный сервер (server/) на этом ПК — обычно ws://127.0.0.1:8787.';
  } else {
    fallback = 'Адрес и пароль даст стример: ws://<его белый IP>:8787.';
  }
  hint.textContent = text ?? fallback;
}

/**
 * Внешний IP стримера для адреса зрителю и кандидатов проброшенного порта: из настроек, иначе
 * по HTTPS (так же, как зритель придёт к серверу по TCP), и только в крайнем случае через STUN —
 * провайдер или роутер может уводить UDP к серверам Google через другой адрес.
 */
async function detectPublicIp(network) {
  if (network.publicIp) return network.publicIp;
  return (await window.duo.getPublicIp()) ?? stunPublicIp(network);
}

async function stunPublicIp(network) {
  const pc = new RTCPeerConnection({ iceServers: network.iceServers });
  try {
    const found = new Promise((resolve) => {
      setTimeout(() => resolve(null), 4000);
      pc.onicecandidate = (e) => {
        if (!e.candidate) resolve(null);
        else if (e.candidate.type === 'srflx' && e.candidate.address && !e.candidate.address.includes(':')) resolve(e.candidate.address);
      };
    });
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    return await found;
  } catch {
    return null;
  } finally {
    pc.close();
  }
}

/** Запускает встроенный сервер; если порт уже занят (работает отдельный server/), подключаемся к нему. */
async function startHostedServer(port, password) {
  const result = await window.duo.server.start(port, password);
  if (!result.ok && result.code !== 'EADDRINUSE') throw new Error(`встроенный сервер не запустился: ${result.error}`);
  if (!result.ok) toast(`Порт ${port} уже занят — подключаюсь к уже запущенному серверу`, 'warn', 7000);
  state.hostedServer = { port, own: result.ok };
}

/** Стример: адрес, который нужно передать зрителю, и белый IP для кандидатов проброшенного порта. */
function prepareShareAddress(port) {
  state.share = { address: `ws://<ваш белый IP>:${port}` };
  detectPublicIp(state.cfg.network).then((ip) => {
    if (!ip || !state.share) return;
    state.publicIp = ip;
    state.share.address = `ws://${ip}:${port}`;
    if (state.role === 'streamer') state.session?.addPublicIp(ip);
    render();
  });
}

async function connect(event) {
  event.preventDefault();
  const role = selectedRole();
  const hostServer = role === 'streamer' && $('#fHostServer').checked;
  const port = Math.round(Number($('#fPort').value));
  const url = hostServer ? `ws://127.0.0.1:${port}` : $('#fUrl').value.trim();
  const password = $('#fPassword').value;
  const name = $('#fName').value.trim();
  if (hostServer && !(port >= 1 && port <= 65535)) return updateConnectHint('Порт — число от 1 до 65535, обычно 8787', true);
  if (!/^wss?:\/\/[^\s/]+/i.test(url)) return updateConnectHint('Адрес должен начинаться с ws://, например ws://203.0.113.10:8787', true);
  if (password.length < 8) return updateConnectHint('Пароль — не короче 8 символов, одинаковый у стримера и зрителя', true);

  $('#btnConnect').disabled = true;
  try {
    const signalingCfg = { ...state.cfg.signaling, password, role, displayName: name, hostServer, serverPort: port || state.cfg.signaling.serverPort };
    if (!hostServer) signalingCfg.url = url;
    state.cfg = await window.duo.saveConfig({ ...state.cfg, signaling: signalingCfg });
    state.role = role;
    if (hostServer) await startHostedServer(port, password);
    if (role === 'streamer') prepareShareAddress(hostServer ? port : Number(new URL(url).port) || 80);
    await ensureMic();
    if (role === 'streamer') await ensureCodecProbe();

    const signaling = new SignalingClient({ url, password, role, name: name || ROLE_NAME[role] });
    state.signaling = signaling;
    signaling.onSignal = handleSignal;
    signaling.addEventListener('state', onSignalingState);
    signaling.addEventListener('welcome', (e) => {
      state.peer = e.detail.peer;
      if (state.peer) onPeerPresent();
      render();
    });
    signaling.addEventListener('peer-joined', (e) => {
      state.peer = e.detail.peer;
      toast(`${e.detail.peer.name} подключился`, 'ok');
      onPeerPresent();
      render();
    });
    signaling.addEventListener('peer-left', onPeerLeft);
    signaling.addEventListener('server-error', (e) => onServerError(e.detail));
    await signaling.connect();
  } catch (err) {
    toast(`Не удалось подключиться: ${err.message}`, 'error');
    teardown();
  } finally {
    $('#btnConnect').disabled = false;
    render();
  }
}

function onSignalingState({ detail }) {
  if (detail.state === 'reconnecting') {
    state.sigInfo = `Сервер: ${detail.message}, повтор через ${Math.round(detail.delay / 1000)} с`;
  } else if (detail.state === 'failed') {
    toast(`Сигнальный сервер: ${detail.message}`, 'error', 8000);
    teardown();
    updateConnectHint(detail.message, true);
  }
  render();
}

function onServerError({ code, message }) {
  // no-peer — сообщение ушло в момент, когда собеседник отключался; фатальные покажет onSignalingState
  if (code === 'no-peer' || FATAL_CODES.has(code)) return;
  toast(message, 'error', 8000);
}

function onPeerPresent() {
  if (state.role !== 'streamer') return; // зритель ждёт offer
  startStreamerSession().catch((err) => toast(`Ошибка WebRTC: ${err.message}`, 'error'));
}

function onPeerLeft() {
  toast(`${state.peer?.name ?? 'Собеседник'} отключился`, 'warn');
  state.peer = null;
  closeSession();
  render();
}

async function disconnect() {
  await Promise.race([closeSession({ bye: true }), sleep(500)]);
  teardown();
}

function teardown() {
  closeSession();
  if (state.screen) {
    stopCapture(state.screen, state.capture);
    Object.assign(state, { screen: null, capture: null, nativeStats: null });
  }
  const signaling = state.signaling;
  state.signaling = null;
  state.peer = null;
  signaling?.close();
  // Встроенный сервер живёт, пока стример подключён
  if (state.hostedServer?.own) window.duo.server.stop();
  state.hostedServer = null;
  state.share = null;
  state.mic?.stop();
  state.mic = null;
  render();
}

// ======================= WebRTC-сессия =======================

function createSession(role, sid) {
  let serverHost = '';
  try {
    serverHost = new URL(state.signaling?.url ?? '').hostname;
  } catch {
    // адрес уже проверен при подключении
  }
  const session = new PeerSession({
    role,
    sid,
    cfg: state.cfg,
    send: (msg) => state.signaling?.sendSignal(msg) ?? Promise.resolve(false),
    micTrack: state.mic?.track ?? null,
    serverHost,
    publicIp: role === 'streamer' ? state.publicIp : null,
  });
  session.addEventListener('track', onRemoteTrack);
  session.addEventListener('state', (e) => onPeerState(session, e.detail.state));
  session.addEventListener('gave-up', () =>
    toast('Не удалось восстановить P2P-соединение. Проверьте сеть и проброс портов, затем переподключитесь.', 'error', 10000),
  );
  session.addEventListener('forwarded-candidate', (e) =>
    console.log(`[ice] кандидат через проброшенный порт: ${e.detail.ip}:${e.detail.port}`),
  );
  state.session = session;
  state.monitor = new StatsMonitor(session);
  state.stats = null;
  state.swStrikes = 0;
  state.pathAnnounced = false;
  return session;
}

async function startStreamerSession() {
  closeSession();
  const session = createSession('streamer');
  await session.startAsStreamer({
    codecOrder: state.codecOrder,
    screenStream: state.screen,
    scaleDownBy: state.capture?.scale ?? 1,
  });
  sendStreamState();
}

/** Закрывает текущую сессию; с bye=true предупреждает собеседника. Возвращает промис отправки bye. */
function closeSession({ bye = false } = {}) {
  const session = state.session;
  if (!session) return Promise.resolve();
  const sent = bye ? session.send({ kind: 'bye' }) : Promise.resolve();
  session.close();
  state.session = null;
  state.monitor = null;
  state.stats = null;
  state.remoteVideo = null;
  state.remote = { live: false, info: null };
  $('#voiceAudio').srcObject = null;
  $('#systemAudio').srcObject = null;
  render();
  return sent;
}

async function handleSignal(msg) {
  try {
    if (msg.kind === 'offer') {
      if (state.role !== 'viewer') return;
      if (!state.session || state.session.sid !== msg.sid) {
        closeSession();
        createSession('viewer', msg.sid);
      }
      state.remote.live = Boolean(msg.live);
      await state.session.handleOffer(msg);
      return;
    }
    const session = state.session;
    if (!session || msg.sid !== session.sid) return;
    switch (msg.kind) {
      case 'answer':
        await session.handleAnswer(msg);
        break;
      case 'candidate':
        await session.addRemoteCandidate(msg.candidate);
        break;
      case 'restart-request':
        session.recover({ force: true });
        break;
      case 'stream-state': {
        const wasLive = state.remote.live;
        state.remote = { live: Boolean(msg.live), info: msg };
        if (msg.live && !wasLive) toast(`Трансляция началась: ${msg.source || 'экран'}`, 'ok');
        if (!msg.live && wasLive) toast('Стример остановил трансляцию', 'warn');
        break;
      }
      case 'bye':
        toast('Собеседник завершил сеанс', 'warn');
        closeSession();
        break;
      default:
        break;
    }
  } catch (err) {
    toast(`Ошибка согласования WebRTC: ${err.message}`, 'error', 8000);
  } finally {
    render();
  }
}

function onPeerState(session, pcState) {
  if (session !== state.session) return;
  if (pcState === 'connected' && !state.pathAnnounced) {
    state.pathAnnounced = true;
    setTimeout(async () => {
      if (session !== state.session) return;
      const stats = await state.monitor?.sample().catch(() => null);
      if (stats?.path) toast(`Соединение: ${formatPath(stats.path)}`, stats.path.relay ? 'warn' : 'ok', 6000);
    }, 700);
  }
  render();
}

function onRemoteTrack({ detail }) {
  const { kind, stream, track } = detail;
  if (kind === 'video') {
    state.remoteVideo = stream;
    track.addEventListener('unmute', render);
  } else {
    attachAudio(kind === 'system' ? $('#systemAudio') : $('#voiceAudio'), stream);
  }
  render();
}

async function attachAudio(audio, stream) {
  audio.srcObject = stream;
  await applySink(audio);
  audio.play().catch(() => {});
}

async function applySink(audio) {
  const id = state.cfg.audio.outputDeviceId;
  try {
    await audio.setSinkId(id === 'default' ? '' : id);
  } catch (err) {
    toast(`Устройство вывода недоступно: ${err.message}`, 'warn');
  }
}

// ======================= трансляция (стример) =======================

function captureConstraints(video) {
  const constraints = { frameRate: { ideal: video.frameRate, max: video.frameRate } };
  if (video.width && video.height) Object.assign(constraints, { width: { max: video.width }, height: { max: video.height } });
  return constraints;
}

async function startStream() {
  const v = state.cfg.video;
  const resolution = v.width && v.height ? `${v.width}×${v.height}` : 'разрешение источника';
  const pick = await openSourcePicker({
    captureAudio: state.cfg.audio.captureSystemAudio,
    info: `${resolution} · ${v.frameRate} FPS · до ${formatKbps(v.bitrateKbps)} · ${state.codecOrder[0] ?? v.codecs[0]}`,
  });
  if (pick) await beginCapture(pick);
}

/**
 * Открывает захват источника. Сначала — собственный (WGC + sharedTexture, до 120 FPS), при любой
 * ошибке — встроенный захват Chromium (getDisplayMedia, на Windows 11 24H2+ до ~60 FPS).
 * @returns {Promise<{stream:MediaStream, engine:'native'|'chromium', native?:NativeCaptureTrack, width:number, height:number}>}
 */
async function openCapture(pick, { forceChromium = false } = {}) {
  const v = state.cfg.video;
  if (!forceChromium && v.captureEngine === 'auto' && state.nativeStatus?.available) {
    const native = new NativeCaptureTrack();
    try {
      const stream = await native.start(pick.source.id, { fps: v.frameRate, contentHint: v.contentHint });
      if (pick.audio) await addSystemAudio(stream, pick.source);
      return { stream, engine: 'native', native, width: native.width, height: native.height };
    } catch (err) {
      native.stop();
      toast(`Собственный захват не запустился (${err.message}). Использую захват Chromium — до ~60 FPS.`, 'warn', 9000);
    }
  }
  await window.duo.selectSource(pick.source, pick.audio);
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: captureConstraints(v), audio: pick.audio });
  const s = stream.getVideoTracks()[0].getSettings();
  return { stream, engine: 'chromium', width: s.width, height: s.height };
}

/** Системный звук при собственном захвате: getDisplayMedia ради loopback-аудио, видео сразу останавливаем. */
async function addSystemAudio(stream, source) {
  try {
    await window.duo.selectSource(source, true);
    const loopback = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: { max: 320 }, height: { max: 180 } },
      audio: true,
    });
    loopback.getVideoTracks().forEach((t) => t.stop());
    const track = loopback.getAudioTracks()[0];
    if (track) stream.addTrack(track);
    else toast('Системный звук недоступен', 'warn');
  } catch (err) {
    toast(`Системный звук недоступен: ${err.message}`, 'warn');
  }
}

/** Во сколько раз уменьшить кадр собственного захвата до выбранного разрешения (Chromium уменьшает сам). */
function captureScale(capture) {
  const v = state.cfg.video;
  if (capture.engine !== 'native' || !v.width || !v.height || !capture.width) return 1;
  return Math.max(1, capture.width / v.width, capture.height / v.height);
}

function stopCapture(stream, capture) {
  stream?.getTracks().forEach((t) => t.stop());
  capture?.native?.stop();
}

/** Запускает (или переключает) трансляцию выбранного источника. */
async function beginCapture(pick, options) {
  let capture;
  try {
    capture = await openCapture(pick, options);
  } catch (err) {
    toast(`Не удалось захватить «${pick.source.name}»: ${err.message}`, 'error');
    return false;
  }
  const v = state.cfg.video;
  const stream = capture.stream;
  const track = stream.getVideoTracks()[0];
  // 'motion' — WebRTC кодирует как видео (держит FPS), а не как «презентацию» с низкой частотой кадров
  track.contentHint = v.contentHint;
  track.addEventListener('ended', () => {
    if (state.screen === stream) stopStream('Источник захвата закрыт — трансляция остановлена');
  });
  capture.scale = captureScale(capture);
  capture.lastArea = (capture.width / capture.scale) * (capture.height / capture.scale);

  const previous = { stream: state.screen, capture: state.capture };
  Object.assign(state, { screen: stream, capture, sourceName: pick.source.name, lastPick: pick, lastEncoderRestart: 0, nativeStats: null });
  stopCapture(previous.stream, previous.capture);

  const width = Math.round(capture.width / capture.scale);
  const height = Math.round(capture.height / capture.scale);
  if (state.session?.wouldGrowFrame(width * height)) {
    // Кадр стал больше прежнего — пересоздаём сессию, иначе Chromium уйдёт с NVENC на CPU
    await startStreamerSession();
  } else if (state.session) {
    await state.session.setScreen(stream, { scaleDownBy: capture.scale });
    sendStreamState();
  }

  const engine = capture.engine === 'native' ? 'собственный захват' : 'захват Chromium';
  const withAudio = stream.getAudioTracks().length ? ' · со звуком' : '';
  toast(`Трансляция: ${pick.source.name} · ${width}×${height} · до ${v.frameRate} FPS · ${engine}${withAudio}`, 'ok');
  if (capture.engine === 'native') watchNativeFrames(capture);
  render();
  return true;
}

/** Если кадры собственного захвата не дошли до трека за 3 с — переходим на захват Chromium. */
function watchNativeFrames(capture) {
  setTimeout(() => {
    if (state.capture === capture && capture.native.frames === 0) fallbackToChromium('кадры не поступают');
  }, 3000);
}

async function fallbackToChromium(reason) {
  const capture = state.capture;
  if (!state.lastPick || capture?.engine !== 'native') return;
  toast(`Собственный захват остановился (${reason}). Переключаюсь на захват Chromium…`, 'warn', 9000);
  if (!(await beginCapture(state.lastPick, { forceChromium: true }))) stopStream();
}

/** События процесса собственного захвата (src/main/native-capture.js). */
function onNativeEvent(e) {
  const capture = state.capture;
  if (capture?.engine !== 'native' || capture.native.session !== e.session) return;
  if (e.type === 'stats') {
    state.nativeStats = e;
  } else if (e.type === 'size') {
    // Окно изменило размер
    Object.assign(capture, { width: e.width, height: e.height });
    capture.scale = captureScale(capture);
    state.session?.setScale(capture.scale);
    // Энкодер Chromium уходит на CPU при любом росте кадра относительно предыдущего
    const area = (capture.width / capture.scale) * (capture.height / capture.scale);
    if (capture.lastArea && area > capture.lastArea) capture.grewSinceEncoderStart = true;
    capture.lastArea = area;
    scheduleGrowthCheck(capture);
  } else if (e.type === 'closed') {
    stopStream('Источник захвата закрыт — трансляция остановлена');
  } else if (e.type === 'error') {
    fallbackToChromium(e.message);
  }
}

/**
 * Окно выросло больше, чем кадр, под который создан аппаратный энкодер, — Chromium в таком случае
 * уходит на CPU. Когда размер перестанет меняться, пересоздаём сессию (новый энкодер под новый размер).
 */
function scheduleGrowthCheck(capture) {
  clearTimeout(state.growthTimer);
  state.growthTimer = setTimeout(() => {
    if (state.capture !== capture || !capture.grewSinceEncoderStart || !state.session) return;
    capture.grewSinceEncoderStart = false;
    state.lastEncoderRestart = Date.now();
    startStreamerSession().catch((err) => toast(`Ошибка WebRTC: ${err.message}`, 'error'));
  }, 800);
}

async function stopStream(reason) {
  const stream = state.screen;
  if (!stream) return;
  const capture = state.capture;
  Object.assign(state, { screen: null, capture: null, sourceName: '', nativeStats: null });
  stopCapture(stream, capture);
  if (state.session) await state.session.setScreen(null);
  sendStreamState();
  if (reason) toast(reason, 'warn');
  render();
}

function sendStreamState() {
  if (!state.session || state.role !== 'streamer') return;
  const c = state.capture;
  state.session.send({
    kind: 'stream-state',
    live: Boolean(state.screen),
    source: state.sourceName,
    width: c ? Math.round(c.width / c.scale) : undefined,
    height: c ? Math.round(c.height / c.scale) : undefined,
    frameRate: state.cfg.video.frameRate,
    engine: c?.engine,
    audio: Boolean(state.screen?.getAudioTracks().length),
  });
}

function captureSummary() {
  const c = state.capture;
  if (!c) return '—';
  if (c.engine === 'chromium') return 'Chromium (getDisplayMedia)';
  const s = state.nativeStats;
  const perf = s
    ? ` · ${s.fps.toFixed(0)} к/с, копирование ${s.copyMs.toFixed(2)} мс, пропущено ${s.dropped}, текстур в работе ${s.inFlight}`
    : '';
  return `собственный (WGC)${perf}`;
}

// ======================= кодеки =======================

async function ensureCodecProbe(force = false) {
  if (state.probe && !force) return;
  const v = state.cfg.video;
  state.probe = await probeVideoCodecs(v.codecs, v);
  state.codecOrder = orderCodecs(state.probe, v.preferHardware);
  if (!state.codecOrder.length) state.codecOrder = [...v.codecs];
  console.log('[codecs]', state.probe, '→', state.codecOrder.join(' → '));

  const first = state.probe.find((p) => p.name === state.codecOrder[0]);
  if (v.preferHardware && state.codecOrder[0] !== v.codecs[0]) {
    toast(`${v.codecs[0]} не кодируется аппаратно на этом ПК — основной кодек ${state.codecOrder[0]}`, 'warn', 8000);
  } else if (first?.hardware === false) {
    toast(`Аппаратный энкодер для ${first.name} не найден — кодирование будет на CPU`, 'warn', 8000);
  }
}

/**
 * Страховка поверх MediaCapabilities: если по статистике кадры кодируются программно
 * (libaom/libvpx/OpenH264), переключаемся на следующий кодек из списка.
 */
function checkEncoder(stats) {
  const v = stats.video;
  const session = state.session;
  if (!session || session.hwSearchDone || !v || v.direction !== 'out' || !v.fps || !state.cfg.video.preferHardware) return;
  if (v.hw !== false) {
    state.swStrikes = 0;
    return;
  }
  if (++state.swStrikes < SW_ENCODER_STRIKES) return;
  state.swStrikes = 0;

  // Кодек умеет аппаратно, но энкодер «отвалился» (рост кадра, сбой драйвера) — пересоздаём сессию
  // с тем же кодеком. Если это уже делали недавно и не помогло — переходим к следующему кодеку.
  const probe = state.probe?.find((p) => p.name === v.codec);
  if (probe?.hardware === true && Date.now() - state.lastEncoderRestart > ENCODER_RESTART_COOLDOWN_MS) {
    state.lastEncoderRestart = Date.now();
    toast(`${v.codec}: аппаратный энкодер отключился (${v.impl || 'CPU'}). Перезапускаю видеосессию…`, 'warn', 7000);
    startStreamerSession().catch((err) => toast(`Ошибка WebRTC: ${err.message}`, 'error'));
    return;
  }
  if (v.codec) session.triedCodecs.add(v.codec);

  const next = session.codecOrder.find((c) => !session.triedCodecs.has(c));
  if (!next) {
    session.hwSearchDone = true;
    toast('Аппаратное кодирование недоступно ни для одного кодека — видео кодируется на CPU', 'warn', 10000);
    const original = state.cfg.video.codecs[0];
    if (v.codec !== original) session.switchCodecs([original, ...session.codecOrder.filter((c) => c !== original)]);
    return;
  }
  toast(`${v.codec}: кодирование идёт на CPU (${v.impl || 'программный энкодер'}). Переключаюсь на ${next}…`, 'warn', 7000);
  session.switchCodecs([next, ...session.codecOrder.filter((c) => c !== next)]).catch((err) => toast(err.message, 'error'));
}

// ======================= микрофон =======================

async function ensureMic() {
  if (state.mic) return;
  const mic = new MicPipeline();
  mic.addEventListener('change', () => {
    if (mic.denoiseEngine === 'error' && !state.denoiseErrorShown) {
      state.denoiseErrorShown = true;
      toast(`Шумодав не загрузился: ${mic.denoiseError}. Голос идёт без шумоподавления.`, 'error', 10000);
    }
    render();
  });
  try {
    await mic.start(state.cfg.audio);
    state.mic = mic;
    refreshOutputs(); // после разрешения на микрофон у устройств появляются названия
  } catch (err) {
    mic.stop();
    toast(`Микрофон недоступен (${err.message}). Подключаюсь без голоса.`, 'warn', 8000);
  }
}

function toggleMic() {
  if (!state.mic) return;
  state.mic.setMuted(!state.mic.muted);
}

async function toggleDenoise() {
  if (!state.mic) return;
  const on = !state.mic.denoiseWanted;
  state.mic.setDenoise(on);
  state.cfg = await window.duo.saveConfig({ ...state.cfg, audio: { ...state.cfg.audio, noiseSuppression: on } });
}

function denoiseSummary() {
  const mic = state.mic;
  if (!mic) return '—';
  const s = mic.denoiseState;
  if (s === 'off') return 'выключен';
  if (s === 'loading') return 'загрузка модели…';
  if (s === 'error') return `ошибка: ${mic.denoiseError}`;
  const p = mic.perf;
  return `DTLN · ${p.avgMs.toFixed(2)} мс на кадр 8 мс (макс ${p.maxMs.toFixed(1)}), пропусков ${p.underruns + p.dropped}`;
}

/** Шкала индикатора: −60…0 дБ → 0…1, как у индикатора микрофона */
const meterScale = (db) => Math.min(1, Math.max(0, (db + 60) / 60));

function meterLoop() {
  const level = state.mic?.level() ?? 0;
  $('#micLevel').style.transform = `scaleX(${level.toFixed(3)})`;
  const voice = state.session?.remoteVoiceLevel() ?? 0;
  const voiceDb = voice > 0 ? 20 * Math.log10(voice) : -Infinity;
  state.voicePeakDb = Math.max(state.voicePeakDb, voiceDb);
  $('#voiceLevel').style.transform = `scaleX(${meterScale(voiceDb).toFixed(3)})`;
  requestAnimationFrame(meterLoop);
}

/** Куда выводится голос собеседника — по названию устройства, а не по deviceId */
function outputLabel() {
  const id = state.cfg.audio.outputDeviceId;
  return state.outputs.get(id) ?? (id === 'default' ? 'устройство по умолчанию' : 'выбранное устройство (сейчас не найдено)');
}

async function refreshOutputs() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  state.outputs = new Map(devices.filter((d) => d.kind === 'audiooutput' && d.label).map((d) => [d.deviceId, d.label]));
}

function voiceSummary() {
  const db = state.voiceDb;
  const level = db > -55 ? `есть звук (${Math.round(db)} дБ)` : 'тишина: собеседник молчит или выключил микрофон';
  return `${level} → ${outputLabel()}`;
}

// ======================= статистика =======================

async function tickStats() {
  state.voiceDb = state.voicePeakDb;
  state.voicePeakDb = -Infinity;
  const monitor = state.monitor;
  if (!monitor || state.session?.pc.connectionState !== 'connected') {
    renderQuality(null);
    return;
  }
  const stats = await monitor.sample();
  if (monitor !== state.monitor) return;
  state.stats = stats;
  renderQuality(stats);
  if (state.role === 'streamer') {
    if (stats.video?.direction === 'out') state.session.noteEncodedFrame(stats.video.width, stats.video.height);
    checkEncoder(stats);
  }
}

function renderQuality(stats) {
  const button = $('#btnQuality');
  if (!stats) {
    button.dataset.quality = 'unknown';
    $('#qualityText').textContent = state.session ? 'Соединение…' : 'Нет соединения';
  } else {
    button.dataset.quality = stats.quality;
    const out = state.role === 'streamer';
    const kbps = stats.video?.kbps ?? (out ? stats.audio.outKbps : stats.audio.inKbps);
    const ping = stats.rttMs != null ? `${Math.round(stats.rttMs)} мс` : '— мс';
    const loss = stats.lossPct != null ? `${stats.lossPct.toFixed(1)}%` : '0.0%';
    $('#qualityText').textContent = `${out ? '↑' : '↓'} ${formatKbps(kbps)} · ${ping} · потери ${loss}`;
  }
  if (state.hudOpen) {
    const extra = { 'Голос собеседника': voiceSummary() };
    if (state.mic) extra['Шумодав'] = denoiseSummary();
    if (state.capture) extra['Захват'] = captureSummary();
    if (stats) {
      renderList($('#hudList'), describeStats(stats, extra));
    } else if (state.session) {
      // P2P ещё не установлено — показываем, на каком шаге застряли
      const session = state.session;
      describeIce(session)
        .then((rows) => {
          if (state.hudOpen && state.session === session && !state.stats) {
            renderList($('#hudList'), [['P2P', 'ещё не установлено'], ...rows]);
          }
        })
        .catch(() => {});
    } else {
      renderList($('#hudList'), [['', state.peer ? 'P2P-сессия ещё не создана' : 'Нет активного P2P-соединения']]);
    }
  }
}

// ======================= настройки и диагностика =======================

async function saveSettings(next) {
  const prev = state.cfg;
  state.cfg = await window.duo.saveConfig(next);
  const cfg = state.cfg;

  if (state.mic) await state.mic.reconfigure(cfg.audio).catch((err) => toast(`Микрофон: ${err.message}`, 'error'));
  if (prev.audio.outputDeviceId !== cfg.audio.outputDeviceId) {
    await applySink($('#voiceAudio'));
    await applySink($('#systemAudio'));
  }

  const pv = prev.video;
  const cv = cfg.video;
  const captureChanged = pv.width !== cv.width || pv.height !== cv.height || pv.frameRate !== cv.frameRate;
  const track = state.screen?.getVideoTracks()[0];
  if (track && state.lastPick && (pv.captureEngine !== cv.captureEngine || (captureChanged && state.capture?.engine === 'native'))) {
    // Сменился способ захвата или FPS/разрешение собственного захвата — открываем источник заново
    await beginCapture(state.lastPick);
  } else if (track) {
    track.contentHint = cv.contentHint;
    if (captureChanged) {
      await track.applyConstraints(captureConstraints(cv)).catch((err) => toast(`Параметры захвата: ${err.message}`, 'warn'));
      const s = track.getSettings();
      Object.assign(state.capture, { width: s.width, height: s.height });
      if (state.session?.wouldGrowFrame(s.width * s.height)) await startStreamerSession();
      else sendStreamState();
    }
  }

  const codecsChanged = pv.codecs.join() !== cv.codecs.join() || pv.preferHardware !== cv.preferHardware;
  const bitrateChanged = pv.bitrateKbps !== cv.bitrateKbps || pv.minBitrateKbps !== cv.minBitrateKbps;
  if (state.role === 'streamer' && state.signaling && (codecsChanged || captureChanged)) await ensureCodecProbe(true);

  const session = state.session;
  if (session) {
    await session.updateConfig(cfg); // maxBitrate / maxFramerate применяются сразу
    if (state.role === 'streamer' && codecsChanged) {
      session.triedCodecs.clear();
      session.hwSearchDone = false;
      await session.switchCodecs(state.codecOrder);
    } else if (state.role === 'streamer' && bitrateChanged) {
      await session.negotiate(); // x-google-min/start-bitrate меняются только через SDP
    }
    if (JSON.stringify(prev.network) !== JSON.stringify(cfg.network)) {
      toast('Сетевые настройки применятся при следующем подключении', 'info');
    }
  }
  toast('Настройки сохранены', 'ok', 2500);
  render();
}

async function collectDiagnostics() {
  const info = await window.duo.getAppInfo();
  const rows = [['Версии', `DuoStream ${info.versions.app} · Electron ${info.versions.electron} · Chromium ${info.versions.chrome}`]];
  const devices = info.gpu.devices;
  for (const g of devices) rows.push([g.active ? 'GPU (используется)' : 'GPU', `${g.vendor} ${g.description || g.deviceId}`]);
  if (info.gpu.renderer) rows.push(['Рендерер', info.gpu.renderer]);
  const active = devices.find((g) => g.active);
  if (active && active.vendor !== 'NVIDIA' && devices.some((g) => g.vendor === 'NVIDIA')) {
    rows.push([
      'Внимание',
      'Приложение работает не на видеокарте NVIDIA. Параметры Windows → Система → Дисплей → Графика → DuoStream (или electron.exe) → «Высокая производительность».',
    ]);
  }
  rows.push([
    'Аппаратное видео',
    `кодирование: ${info.gpuFeatures.video_encode ?? '?'}, декодирование: ${info.gpuFeatures.video_decode ?? '?'}`,
  ]);
  for (const p of await probeVideoCodecs(['AV1', 'H264', 'VP9'], state.cfg.video)) {
    const verdict = !p.supported
      ? 'не поддерживается'
      : p.hardware === true
        ? 'аппаратный энкодер'
        : p.hardware === false
          ? 'только программно (CPU)'
          : 'поддерживается';
    rows.push([`Кодек ${p.name}`, verdict]);
  }
  if (state.codecOrder.length) rows.push(['Порядок кодеков', state.codecOrder.join(' → ')]);
  const native = info.nativeCapture;
  rows.push(['Собственный захват (до 120 FPS)', native.available ? 'доступен' : `недоступен: ${native.reason}`]);
  rows.push([
    'Способ захвата',
    state.capture
      ? captureSummary()
      : state.cfg.video.captureEngine === 'auto' && native.available
        ? 'собственный, при сбое — Chromium'
        : 'Chromium',
  ]);
  const range = info.udpPortRange;
  rows.push(['UDP-порты WebRTC', range?.min ? `${range.min}–${range.max}` : 'без ограничений']);
  if (state.mic) rows.push(['Микрофон', state.mic.deviceLabel || '—'], ['Шумодав', denoiseSummary()]);
  await refreshOutputs();
  rows.push(['Вывод звука', outputLabel()]);
  if (state.session) rows.push(['Голос собеседника', voiceSummary()]);
  if (state.stats) rows.push(...describeStats(state.stats));
  if (info.profile) rows.push(['Профиль', info.profile]);
  return rows;
}

// ======================= отрисовка =======================

function render() {
  const signaling = state.signaling;
  const connected = Boolean(signaling);
  const streamer = state.role === 'streamer';
  const pcState = state.session?.pc.connectionState ?? null;

  let tone = 'idle';
  let text = 'Не подключено';
  if (signaling) {
    if (signaling.state === 'reconnecting') [tone, text] = ['busy', state.sigInfo || 'Переподключение…'];
    else if (signaling.state !== 'open') [tone, text] = ['busy', 'Подключение к серверу…'];
    else if (!state.peer) [tone, text] = ['busy', streamer ? 'Ожидание зрителя' : 'Ожидание стримера'];
    else if (pcState === 'connected') [tone, text] = ['ok', 'P2P-соединение установлено'];
    else if (pcState === 'failed') [tone, text] = ['error', 'P2P-соединение не удалось'];
    else [tone, text] = ['busy', 'Установка P2P-соединения…'];
  }
  $('#status').dataset.tone = tone;
  $('#statusText').textContent = text;
  $('#peerName').textContent = state.peer ? `${ROLE_NAME[state.peer.role]}: ${state.peer.name}` : '';

  // Сцена
  let message = null;
  let videoStream = null;
  if (connected && signaling.state !== 'open') {
    // Сначала — связь с сигнальным сервером: без неё про собеседника ничего не известно
    message =
      signaling.state === 'reconnecting'
        ? {
            title: 'Нет связи с сигнальным сервером',
            sub:
              `${signaling.url} не отвечает. Проверьте: сервер запущен; адрес верный (из другой сети — белый IP, ` +
              'а не 192.168.x.x); на роутере проброшен TCP-порт; брандмауэр Windows на ПК стримера пропускает порт.',
            spinner: true,
          }
        : { title: 'Подключение к серверу…', sub: signaling.url, spinner: true };
  } else if (connected && streamer) {
    if (state.screen && state.cfg.video.showPreview) videoStream = state.screen;
    else if (state.screen) message = { title: 'Идёт трансляция', sub: `${state.sourceName}. Предпросмотр выключен в настройках.` };
    else
      message = {
        title: 'Трансляция не запущена',
        sub: state.peer
          ? 'Нажмите «Начать стрим» и выберите экран или окно.'
          : 'Можно начать заранее — зритель увидит трансляцию сразу после подключения.',
      };
  } else if (connected) {
    if (!state.peer) message = { title: 'Ожидание стримера', sub: 'Стример ещё не подключился к серверу.', spinner: true };
    else if (pcState !== 'connected')
      message = {
        title: 'Установка P2P-соединения…',
        sub: 'Обмен ICE-кандидатами со стримером. Если затянулось — подробности по кнопке «Соединение…» справа внизу.',
        spinner: true,
      };
    else if (!state.remote.live) message = { title: `${state.peer.name} ещё не начал трансляцию`, sub: 'Голосовой чат уже работает.' };
    else if (state.remoteVideo) videoStream = state.remoteVideo;
  }
  const video = $('#video');
  if (video.srcObject !== videoStream) video.srcObject = videoStream;
  video.hidden = !videoStream;
  $('#previewBadge').hidden = !(streamer && videoStream);

  $('#connectCard').hidden = connected;
  $('#stageMessage').hidden = !message;
  $('#overlay').classList.toggle('dim', Boolean(message) || !connected);
  $('#overlay').hidden = connected && !message;
  if (message) {
    $('#stageTitle').textContent = message.title;
    $('#stageSub').textContent = message.sub;
    $('#stageSpinner').hidden = !message.spinner;
  }
  // Пока зритель не подключился — показываем стримеру адрес, который нужно ему передать
  const share = Boolean(message) && streamer && Boolean(state.share) && !state.peer;
  $('#shareBox').hidden = !share;
  if (share) $('#shareAddress').textContent = state.share.address;

  // Кнопки
  const streamBtn = $('#btnStream');
  streamBtn.hidden = !(connected && streamer);
  streamBtn.classList.toggle('primary', !state.screen);
  streamBtn.classList.toggle('danger', Boolean(state.screen));
  setIcon(streamBtn.querySelector('i'), state.screen ? 'stop' : 'screen');
  streamBtn.querySelector('span').textContent = state.screen ? 'Остановить стрим' : 'Начать стрим';
  $('#btnDisconnect').hidden = !connected;

  const mic = state.mic;
  const micBtn = $('#btnMic');
  micBtn.disabled = !mic;
  micBtn.setAttribute('aria-pressed', String(Boolean(mic) && !mic.muted));
  setIcon(micBtn.querySelector('i'), mic && !mic.muted ? 'mic' : 'micOff');

  const denoiseBtn = $('#btnDenoise');
  const ds = mic?.denoiseState ?? 'off';
  denoiseBtn.disabled = !mic;
  denoiseBtn.dataset.state = ds;
  denoiseBtn.setAttribute('aria-pressed', String(ds !== 'off'));
  $('#denoiseText').textContent = { on: 'Шумодав', off: 'Шумодав выкл', loading: 'Шумодав…', error: 'Шумодав: ошибка' }[ds];

  $('#streamVolumeWrap').hidden = streamer;
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#stage').requestFullscreen().catch(() => {});
}

function restoreVolumes() {
  for (const [inputId, audioId] of [
    ['voiceVolume', 'voiceAudio'],
    ['streamVolume', 'systemAudio'],
  ]) {
    const input = $(`#${inputId}`);
    try {
      const saved = localStorage.getItem(inputId);
      if (saved !== null) input.value = saved;
    } catch {
      // хранилище недоступно — оставляем значение по умолчанию
    }
    $(`#${audioId}`).volume = Number(input.value) / 100;
    input.addEventListener('input', () => {
      $(`#${audioId}`).volume = Number(input.value) / 100;
      try {
        localStorage.setItem(inputId, input.value);
      } catch {
        // не критично
      }
    });
  }
}

function bindEvents() {
  $('#connectCard').addEventListener('submit', connect);
  for (const radio of document.querySelectorAll('input[name=role]')) radio.addEventListener('change', updateConnectFields);
  $('#fHostServer').addEventListener('change', updateConnectFields);
  $('#btnCopyAddress').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.share?.address ?? '');
      toast('Адрес скопирован', 'ok', 2000);
    } catch (err) {
      toast(`Не удалось скопировать: ${err.message}`, 'warn');
    }
  });
  $('#btnStream').addEventListener('click', () => (state.screen ? stopStream() : startStream()));
  $('#btnDisconnect').addEventListener('click', disconnect);
  $('#btnMic').addEventListener('click', toggleMic);
  $('#btnDenoise').addEventListener('click', toggleDenoise);
  $('#btnQuality').addEventListener('click', () => {
    state.hudOpen = !state.hudOpen;
    $('#hud').hidden = !state.hudOpen;
    renderQuality(state.stats);
  });
  $('#btnFullscreen').addEventListener('click', toggleFullscreen);
  $('#video').addEventListener('dblclick', toggleFullscreen);
  $('#btnSettings').addEventListener('click', () => settingsDialog.open(state.cfg, state.configPath));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.code === 'KeyM') {
      e.preventDefault();
      toggleMic();
    }
  });
  window.addEventListener('beforeunload', () => state.session?.send({ kind: 'bye' }));
  navigator.mediaDevices.addEventListener('devicechange', refreshOutputs);
}

async function init() {
  renderIcons();
  const { config, path, error } = await window.duo.getConfig();
  state.cfg = config;
  state.configPath = path;
  state.role = config.signaling.role;
  if (error) toast(error, 'error', 12000);
  state.nativeStatus = await nativeCaptureStatus();
  if (!state.nativeStatus.available) console.warn('[capture] собственный захват недоступен:', state.nativeStatus.reason);
  window.duo.nativeCapture.onEvent(onNativeEvent);

  settingsDialog = new SettingsDialog({ onSave: saveSettings, getDiagnostics: collectDiagnostics });
  fillConnectForm();
  bindEvents();
  restoreVolumes();
  refreshOutputs();
  render();
  setInterval(() => tickStats().catch((err) => console.warn('[stats]', err)), 1000);
  requestAnimationFrame(meterLoop);
}

init().catch((err) => {
  console.error(err);
  toast(`Ошибка запуска интерфейса: ${err.message}`, 'error', 20000);
});
