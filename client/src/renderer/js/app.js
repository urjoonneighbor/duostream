// Главный контроллер интерфейса DuoStream: подключение к серверу, сессия WebRTC,
// захват экрана, микрофон с шумодавом, индикатор качества и настройки.
import { SignalingClient } from './signaling.js';
import { PeerSession } from './peer.js';
import { MicPipeline, DENOISE_MODELS } from './audio.js';
import { probeVideoCodecs, orderCodecs } from './codecs.js';
import { StatsMonitor, describeStats, describeIce, formatKbps, formatPath } from './stats.js';
import { openSourcePicker } from './picker.js';
import { NativeCaptureTrack, nativeCaptureStatus } from './native-capture.js';
import { AppAudioTrack } from './app-audio.js';
import { GlitchDetector } from './glitch.js';
import { FrameRecorder } from './frame-recorder.js';
import { Playback, SendGain } from './playback.js';
import { Chat } from './chat.js';
import { ChatPanel } from './chat-ui.js';
import { SettingsDialog } from './settings.js';
import { $, toast, renderIcons, setIcon, renderList } from './ui.js';
import { playCue } from './tones.js';

// Всё, что интерфейс пишет в консоль (в том числе каждое уведомление), — ещё и в журнал сеанса
// (src/main/logger.js): по нему разбираются проблемы, которые сложно поймать вживую
const formatLogArg = (a) => {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
};
for (const [method, level] of [
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
]) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    original(...args);
    window.duo.log(level, args.map(formatLogArg).join(' '));
  };
}
window.addEventListener('error', (e) => console.error('[ui] ошибка:', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[ui] необработанный отказ:', e.reason));
const STATS_LOG_MS = 60_000; // сводка статистики в журнал раз в минуту (и сразу при важных изменениях)

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
  denoiseWarningShown: '',
  screen: null, // MediaStream захвата экрана (стример)
  capture: null, // {engine:'native'|'chromium', native, width, height, scale}
  hostedServer: null, // встроенный сигнальный сервер стримера: {port, own}
  share: null, // стример: {address, port, fromRouter} — что передать зрителю
  upnp: null, // стример: проброс портов на роутере через UPnP (src/main/upnp.js)
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
  micMuted: false, // микрофон выключен кнопкой или горячей клавишей
  deafened: false, // звук собеседника выключен (и микрофон вместе с ним)
  pttHeld: false, // режим рации: клавиша зажата
  pttTimer: 0,
  updateShown: null, // версия, о которой уже показали уведомление
  statsLogged: null, // что было в последней сводке журнала (logStatsIfNeeded)
  statsLoggedAt: 0,
  chat: new Chat(), // чат и файлы (js/chat.js) — переживает пересоздание WebRTC-сессии
  glitches: null, // зритель: детектор кадров-выбросов (js/glitch.js)
  recorder: new FrameRecorder(), // последние кадры видео для «Отметить глюк» (js/frame-recorder.js)
  glitchMarking: false,
  outputs: new Map(), // deviceId → название устройства вывода звука
  voicePeakDb: -Infinity, // максимум уровня голоса собеседника с прошлого тика статистики
  voiceDb: -Infinity, // то же за последнюю завершённую секунду (для окна статистики)
};

// Для отладки в DevTools (F12): duoDebug.session.pc.remoteDescription.sdp и т. п.
globalThis.duoDebug = state;

let settingsDialog;
let chatPanel;
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
  $('#btnGenPassword').hidden = !hostsServer();
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

/** 16 случайных символов без похожих (0/O, 1/l/I) — около 93 бит, перебрать нереально */
async function generatePassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(16));
  const password = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  const field = $('#fPassword');
  field.value = password;
  field.type = 'text'; // показываем: его нужно передать зрителю
  try {
    await navigator.clipboard.writeText(password);
    toast('Пароль скопирован — передайте его зрителю', 'ok', 5000);
  } catch {
    toast('Пароль создан — передайте его зрителю', 'ok', 5000);
  }
}

/** Запускает встроенный сервер; если порт уже занят (работает отдельный server/), подключаемся к нему. */
async function startHostedServer(port, password) {
  const result = await window.duo.server.start(port, password, state.cfg.signaling.allowedIps);
  const weak = /^password: (.+?) \(config\.json/.exec(result.error ?? '');
  if (weak) throw new Error(`${weak[1]}. Нажмите «Сгенерировать» — получится надёжный пароль`);
  if (!result.ok && result.code !== 'EADDRINUSE') throw new Error(`встроенный сервер не запустился: ${result.error}`);
  if (!result.ok) {
    toast(
      `Порт ${port} занят другим сервером (например, запущенным отдельно node src/server.js) — подключаюсь к нему. ` +
        'Если пароль «неверный», закройте тот сервер или смените порт.',
      'warn',
      12000,
    );
  }
  state.hostedServer = { port, own: result.ok };
}

/** Стример: адрес, который нужно передать зрителю, и белый IP для кандидатов проброшенного порта. */
function prepareShareAddress(port) {
  state.share = { address: `ws://<ваш белый IP>:${port}`, port };
  detectPublicIp(state.cfg.network).then((ip) => {
    // Адрес, который сообщил сам роутер (UPnP), точнее — его не перебиваем
    if (ip && !state.share?.fromRouter) applyPublicIp(ip);
  });
}

function applyPublicIp(ip, { fromRouter = false } = {}) {
  if (!state.share) return;
  state.publicIp = ip;
  state.share.address = `ws://${ip}:${state.share.port}`;
  if (fromRouter) state.share.fromRouter = true;
  if (state.role === 'streamer') state.session?.addPublicIp(ip);
  render();
}

/**
 * Стример: просим роутер открыть порт сервера и UDP-диапазон WebRTC (UPnP) — без ручного проброса.
 * Не ждём: подключение к серверу идёт параллельно, результат появится под адресом для зрителя.
 */
function openRouterPorts(serverPort) {
  const n = state.cfg.network;
  if (!n.upnp) return;
  const { min, max } = n.udpPortRange;
  const udp = min ? Array.from({ length: max - min + 1 }, (_, i) => min + i) : [];
  state.upnp = { status: 'working' };
  render();
  window.duo.upnp
    .open(serverPort ? [serverPort] : [], udp)
    .catch((err) => ({ status: 'unavailable', message: err.message }))
    .then((result) => {
      if (!state.signaling || state.role !== 'streamer') return;
      state.upnp = result;
      if (result.cgnat) {
        toast(
          `У роутера нет белого IP: провайдер выдал ему серый адрес ${result.externalIp}. Зритель не сможет ` +
            'подключиться — нужен белый IP у провайдера (docs/03-static-ip.md).',
          'error',
          15000,
        );
      } else if (result.externalIp && !n.publicIp) {
        applyPublicIp(result.externalIp, { fromRouter: true });
      }
      render();
    });
}

function upnpNote() {
  const u = state.upnp;
  if (!u) return '';
  if (u.status === 'working') return 'Открываю порты на роутере (UPnP)…';
  if (u.status === 'unavailable') {
    return 'Роутер не открыл порты сам (UPnP выключен или не поддерживается). Если порты уже проброшены вручную — всё в порядке, иначе включите UPnP в настройках роутера.';
  }
  const manual = u.manual ? `, ${u.manual} уже были проброшены вручную` : '';
  if (u.status === 'partial') return `Часть портов роутер не открыл: ${u.message}`;
  return `Порты открыты на роутере автоматически (UPnP${u.router ? `, ${u.router}` : ''}${manual}) — до отключения.`;
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
  console.log(`[connect] ${role}, сервер ${hostServer ? `встроенный, порт ${port}` : url}`);
  try {
    const signalingCfg = { ...state.cfg.signaling, password, role, displayName: name, hostServer, serverPort: port || state.cfg.signaling.serverPort };
    if (!hostServer) signalingCfg.url = url;
    state.cfg = await window.duo.saveConfig({ ...state.cfg, signaling: signalingCfg });
    state.role = role;
    if (hostServer) await startHostedServer(port, password);
    if (role === 'streamer') prepareShareAddress(hostServer ? port : Number(new URL(url).port) || 80);
    if (role === 'streamer') openRouterPorts(hostServer ? port : null);
    await ensureMic();
    if (role === 'streamer') await ensureCodecProbe();

    const signaling = new SignalingClient({ url, password, role, name: name || ROLE_NAME[role] });
    state.signaling = signaling;
    signaling.onSignal = handleSignal;
    signaling.addEventListener('state', onSignalingState);
    signaling.addEventListener('welcome', (e) => {
      const was = state.peer;
      state.peer = e.detail.peer;
      if (state.peer) {
        if (!was) uiCue('join');
        onPeerPresent();
      }
      render();
    });
    signaling.addEventListener('peer-joined', (e) => {
      state.peer = e.detail.peer;
      toast(`${e.detail.peer.name} подключился`, 'ok');
      uiCue('join');
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
  state.presenceSent = null; // собеседник (пере)подключился — сообщаем ему своё состояние заново
  sendPresence();
  if (state.role !== 'streamer') return; // зритель ждёт offer
  startStreamerSession().catch((err) => toast(`Ошибка WebRTC: ${err.message}`, 'error'));
}

function onPeerLeft() {
  toast(`${state.peer?.name ?? 'Собеседник'} отключился`, 'warn');
  uiCue('leave');
  state.peer = null;
  state.peerPresence = null;
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
  state.peerPresence = null;
  signaling?.close();
  // Встроенный сервер живёт, пока стример подключён
  if (state.hostedServer?.own) window.duo.server.stop();
  state.hostedServer = null;
  state.share = null;
  if (state.upnp) window.duo.upnp.close(); // порты на роутере больше не нужны
  state.upnp = null;
  state.mic?.stop();
  state.mic = null;
  state.glitches?.stop();
  state.glitches = null;
  state.chat.interrupt();
  console.log('[connect] отключено');
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
  session.addEventListener('datachannels', () => state.chat.attach(session));
  session.addEventListener('state', (e) => onPeerState(session, e.detail.state));
  session.addEventListener('gave-up', () =>
    toast('Не удалось восстановить P2P-соединение. Проверьте сеть и проброс портов, затем переподключитесь.', 'error', 10000),
  );
  session.addEventListener('forwarded-candidate', (e) =>
    console.log(`[ice] кандидат через проброшенный порт: ${e.detail.ip}:${e.detail.port}`),
  );
  state.session = session;
  console.log(`[session] новая WebRTC-сессия (${role}, ${session.sid})`);
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
  console.log(`[session] сессия ${session.sid} закрыта`);
  if (state.chat.session === session) state.chat.detach(); // передачи файлов продолжатся в следующей сессии
  session.close();
  state.session = null;
  state.monitor = null;
  state.stats = null;
  state.remoteVideo = null;
  if (state.role !== 'streamer') state.recorder.attach(null);
  state.remote = { live: false, info: null };
  state.playback.voice.detach();
  state.playback.system.detach();
  render();
  return sent;
}

async function handleSignal(msg) {
  if (msg.kind === 'glitch-mark') {
    markGlitch(false);
    return;
  }
  if (msg.kind === 'presence') {
    // Микрофон и звук собеседника — не зависят от WebRTC-сессии
    const mic = ['on', 'off', 'ptt', 'none'].includes(msg.mic) ? msg.mic : 'on';
    state.peerPresence = { mic, deafened: Boolean(msg.deafened) };
    console.log(`[peer] микрофон ${mic}, звук ${msg.deafened ? 'выключен' : 'включён'}`);
    render();
    return;
  }
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
        if (msg.live && !wasLive) {
          toast(`Трансляция началась: ${msg.source || 'экран'}`, 'ok');
          uiCue('streamStart');
        }
        if (!msg.live && wasLive) {
          toast('Стример остановил трансляцию', 'warn');
          uiCue('streamEnd');
        }
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
  console.log(`[session] P2P: ${pcState}`);
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
    state.recorder.attach(track);
    track.addEventListener('unmute', render);
    if (!state.glitches) {
      state.glitches = new GlitchDetector($('#video'), onGlitch);
      state.glitches.start();
    }
  } else {
    const playback = kind === 'system' ? state.playback.system : state.playback.voice;
    playback.attach(stream);
    applySink(playback);
  }
  render();
}

/**
 * «Отметить глюк»: последние ~2 с кадров видео — у зрителя декодированных, у стримера захваченных — в папку
 * рядом с журналом. Нажал один — сохраняют оба (сигнал собеседнику), по кадрам видно, где рождается глюк.
 * @param {boolean} local отметили здесь (а не собеседник)
 */
async function markGlitch(local) {
  if (local && state.peer) state.signaling?.sendSignal({ kind: 'glitch-mark' });
  if (state.glitchMarking) return;
  const who = local ? 'вы' : state.peer?.name ?? 'собеседник';
  if (!state.recorder.frames.length) {
    console.warn(`[glitch] отметка (${who}): кадров нет — видео не идёт`);
    if (local) toast('Отметка глюка: видео сейчас не идёт — сохранять нечего', 'warn');
    return;
  }
  state.glitchMarking = true;
  try {
    const frames = await state.recorder.dump();
    const role = state.role === 'streamer' ? 'streamer' : 'viewer';
    const res = await window.duo.saveLogFrames(`mark-${role}`, frames);
    const v = state.stats?.video;
    const context = v ? ` | видео ${v.codec} ${v.impl} ${v.width}×${v.height} @ ${v.fps} к/с, потери ${state.stats.lossPct?.toFixed(2) ?? '—'}%` : '';
    console.warn(`[glitch] отметка (${who}): ${res ? `${res.saved} кадров → ${res.dir}` : 'не сохранено (лимит за сеанс)'}${context}`);
    if (res) {
      toast(`Глюк отмечен${local ? '' : ` (${who})`}: ${res.saved} последних кадров сохранено рядом с журналом`, 'ok', 6000, {
        label: 'Показать',
        onClick: () => window.duo.revealLog(),
      });
    }
  } catch (err) {
    console.warn(`[glitch] отметка не сохранилась: ${err.message}`);
  } finally {
    state.glitchMarking = false;
  }
}

/** Кадр-выброс у зрителя: в журнал (с картинкой «до — глюк — после» рядом с ним) */
async function onGlitch(info) {
  const { image, ...rest } = info;
  const file = image ? await window.duo.saveLogImage(image).catch(() => null) : null;
  const v = state.stats?.video;
  const context = v ? ` | видео ${v.codec} ${v.impl} ${v.width}×${v.height}, потери ${state.stats.lossPct?.toFixed(2) ?? '—'}%` : '';
  console.warn(`[glitch] кадр-выброс ${JSON.stringify(rest)}${file ? `, картинка ${file}` : ''}${context}`);
}

function glitchSummary() {
  const g = state.glitches;
  return `${g.count} за сеанс (проверено кадров ${g.checked}; картинки — рядом с журналом)`;
}

/** @param {import('./playback.js').Playback} playback */
async function applySink(playback) {
  try {
    await playback.setSink(state.cfg.audio.outputDeviceId);
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
      const capture = { stream, engine: 'native', native, width: native.width, height: native.height };
      if (pick.audio) await addStreamAudio(capture, pick.source);
      return capture;
    } catch (err) {
      native.stop();
      toast(`Собственный захват не запустился (${err.message}). Использую захват Chromium — до ~60 FPS.`, 'warn', 9000);
    }
  }
  // Звук окна берём отдельно (только его приложение), системный — вместе с видео
  const windowAudio = pick.audio && pick.source.type === 'window';
  await window.duo.selectSource(pick.source, pick.audio && !windowAudio);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: captureConstraints(v),
    audio: pick.audio && !windowAudio ? systemAudioConstraints() : false,
  });
  const s = stream.getVideoTracks()[0].getSettings();
  const capture = { stream, engine: 'chromium', width: s.width, height: s.height, audioSource: pick.audio && !windowAudio ? 'system' : null };
  if (windowAudio) await addStreamAudio(capture, pick.source);
  return capture;
}

/**
 * Звук трансляции. Окно — звук только его приложения (с дочерними процессами), иначе зритель слышал бы
 * всё подряд: музыку, другие окна, уведомления. Экран — весь системный звук без звуков DuoStream.
 * Если звук приложения захватить не вышло (Windows старше 10 2004, нет процесса захвата) — системный.
 */
async function addStreamAudio(capture, source) {
  if (source.type === 'window') {
    const app = new AppAudioTrack();
    try {
      capture.stream.addTrack(await app.start(source.id));
      Object.assign(capture, { appAudio: app, audioSource: 'app' });
      return;
    } catch (err) {
      app.stop();
      toast(`Звук окна отдельно не захватить (${err.message}) — передаю весь системный звук`, 'warn', 9000);
    }
  }
  await addSystemAudio(capture.stream, source);
  if (capture.stream.getAudioTracks().length) capture.audioSource = 'system';
}

/**
 * Системный звук (loopback). restrictOwnAudio — без звука самого DuoStream (Chromium берёт устройство
 * loopbackWithoutChrome): иначе в трансляцию попадает голос зрителя, который играет у стримера, и зритель
 * слышит сам себя. Обработка голоса (эхо-, шумоподавление, АРУ) звук игры только портит и сводит в моно.
 * Если исключать свой звук Chromium не умеет — оставляем эхоподавление: оно хотя бы вычитает голос
 * собеседника, пусть и не сразу (первые секунды трансляции голос пробивается).
 */
function systemAudioConstraints() {
  if (!navigator.mediaDevices.getSupportedConstraints().restrictOwnAudio) return true;
  return { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };
}

/** Системный звук при собственном захвате: getDisplayMedia ради loopback-аудио, видео сразу останавливаем. */
async function addSystemAudio(stream, source) {
  try {
    await window.duo.selectSource(source, true);
    const loopback = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: { max: 320 }, height: { max: 180 } },
      audio: systemAudioConstraints(),
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
  capture?.appAudio?.stop();
  capture?.sendGain?.stop();
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
  const audioTrack = stream.getAudioTracks()[0];
  const withAudio = !audioTrack
    ? ''
    : capture.audioSource === 'app'
      ? ' · со звуком только этого окна'
      : audioTrack.getSettings().restrictOwnAudio
        ? ' · со звуком системы (без звука DuoStream)'
        : ' · со звуком системы';
  if (audioTrack) {
    // Звук трансляции — через регулятор громкости (ползунок «Стрим» у стримера)
    capture.sendGain = new SendGain(audioTrack);
    capture.sendGain.setVolume(Number($('#streamSendVolume').value) / 100);
    stream.removeTrack(audioTrack);
    stream.addTrack(capture.sendGain.track);
  }
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
  state.recorder.attach(stream.getVideoTracks()[0] ?? null);
  stopCapture(previous.stream, previous.capture);

  const width = Math.round(capture.width / capture.scale);
  const height = Math.round(capture.height / capture.scale);
  if (state.session?.wouldGrowFrame(width * height)) {
    // Кадр стал больше прежнего — новый энкодер, иначе Chromium уйдёт с NVENC на CPU
    await state.session.setScreen(stream, { scaleDownBy: capture.scale });
    await restartVideoEncoder('новый источник больше прежнего');
    sendStreamState();
  } else if (state.session) {
    await state.session.setScreen(stream, { scaleDownBy: capture.scale });
    sendStreamState();
  }
  // Энкодер создаётся под первый кадр — запоминаем его размер сразу, не дожидаясь статистики
  state.session?.noteEncodedFrame(width, height);

  const engine = capture.engine === 'native' ? 'собственный захват' : 'захват Chromium';
  toast(`Трансляция: ${pick.source.name} · ${width}×${height} · до ${v.frameRate} FPS · ${engine}${withAudio}`, 'ok');
  if (!previous.stream) uiCue('streamStart'); // смена источника во время трансляции — без сигнала
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
    state.nativeStats = { ...e, write: capture.native.takeWriteStats() };
  } else if (e.type === 'size') {
    // Окно изменило размер
    console.log(`[capture] размер кадра ${capture.width}×${capture.height} → ${e.width}×${e.height}`);
    Object.assign(capture, { width: e.width, height: e.height });
    capture.scale = captureScale(capture);
    state.session?.setScale(capture.scale);
    // Chromium перенастраивает аппаратный энкодер под каждый новый размер, а при росте относительно
    // предыдущего (даже после уменьшения и до прежнего размера) уходит на CPU — замерено. Поэтому любой
    // рост — повод пересоздать энкодер (без переподключения, см. restartVideoEncoder)
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
    restartVideoEncoder('окно выросло').catch((err) => toast(`Ошибка WebRTC: ${err.message}`, 'error'));
  }, 800);
}

/**
 * Новый аппаратный энкодер под больший кадр. Сначала — без переподключения: видеопоток выключается
 * и включается, WebRTC создаёт энкодер заново, а соединение, звук и чат не трогаются. Если через 3 с
 * кодирование всё равно на CPU — пересоздаём всю WebRTC-сессию (зритель на секунду увидит переподключение).
 */
async function restartVideoEncoder(reason) {
  const session = state.session;
  if (!session || !state.capture) return;
  state.lastEncoderRestart = Date.now();
  console.log(`[encoder] пересоздаю видеоэнкодер (${reason}) без переподключения`);
  await session.resetVideoEncoder();
  const area = Math.round(state.capture.width / state.capture.scale) * Math.round(state.capture.height / state.capture.scale);
  session.maxFrameArea = area; // новый энкодер создан под текущий кадр
  state.capture.lastArea = area;
  await sleep(3000);
  if (state.session !== session) return;
  const stats = await state.monitor?.sample().catch(() => null);
  const v = stats?.video;
  console.log(`[encoder] после пересоздания: ${v ? `${v.codec} ${v.impl} ${v.width}×${v.height}` : 'нет статистики'}`);
  if (v && v.hw === false) {
    console.log('[encoder] без переподключения не вышло — пересоздаю сессию');
    await startStreamerSession();
  }
}

async function stopStream(reason) {
  const stream = state.screen;
  if (!stream) return;
  const capture = state.capture;
  Object.assign(state, { screen: null, capture: null, sourceName: '', nativeStats: null });
  state.recorder.attach(null);
  stopCapture(stream, capture);
  uiCue('streamEnd');
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
  // Где стоят кадры, если текстуры кончаются: доставка в окно (занят интерфейс) или запись в трек (энкодер)
  const ms = (avg, max) => `${avg.toFixed(1)} мс (макс ${max.toFixed(0)})`;
  const perf = s
    ? ` · ${s.fps.toFixed(0)} к/с, копирование ${s.copyMs.toFixed(2)} мс, пропущено ${s.dropped}, текстур в работе ${s.inFlight}` +
      `, доставка в окно ${ms(s.deliverMs ?? 0, s.deliverMaxMs ?? 0)}, запись в трек ${ms(s.write.avgMs, s.write.maxMs)}`
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

  // Кодек умеет аппаратно, но энкодер «отвалился» (рост кадра, сбой драйвера) — пересоздаём энкодер
  // (сначала без переподключения). Если это уже делали недавно и не помогло — переходим к следующему кодеку.
  const probe = state.probe?.find((p) => p.name === v.codec);
  if (probe?.hardware === true && Date.now() - state.lastEncoderRestart > ENCODER_RESTART_COOLDOWN_MS) {
    console.warn(`[encoder] ${v.codec}: кодирование ушло на CPU (${v.impl || 'программный энкодер'})`);
    restartVideoEncoder('энкодер ушёл на CPU').catch((err) => toast(`Ошибка WebRTC: ${err.message}`, 'error'));
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
    if (mic.denoiseWarning && mic.denoiseWarning !== state.denoiseWarningShown) {
      state.denoiseWarningShown = mic.denoiseWarning;
      toast(mic.denoiseWarning, 'warn', 10000);
    }
    render();
  });
  try {
    await mic.start(state.cfg.audio);
    state.mic = mic;
    applyVoiceState(); // выключенный микрофон и режим рации переживают переподключение
    refreshOutputs(); // после разрешения на микрофон у устройств появляются названия
  } catch (err) {
    mic.stop();
    toast(`Микрофон недоступен (${err.message}). Подключаюсь без голоса.`, 'warn', 8000);
  }
}

// ======================= микрофон, звук, рация =======================

/** Режим рации включён и клавиша назначена */
const pushToTalk = () => state.cfg.audio.pushToTalk && Boolean(state.cfg.hotkeys.pushToTalk);

/** Микрофон передаётся: не выключен, звук не выключен, а в режиме рации ещё и зажата клавиша */
function applyVoiceState() {
  const transmit = !state.micMuted && !state.deafened && (!pushToTalk() || state.pttHeld);
  state.mic?.setMuted(!transmit);
  state.playback.voice.setMuted(state.deafened);
  state.playback.system.setMuted(state.deafened);
  sendPresence();
  render();
}

/** Звук события (подключение собеседника, начало и конец трансляции), если не выключен в настройках */
function uiCue(kind) {
  if (state.cfg.audio.uiSounds) playCue(kind, state.cfg.audio.outputDeviceId);
}

/** Своё состояние для собеседника: 'on' | 'off' | 'ptt' | 'none' (нет микрофона) */
function micPresence() {
  if (!state.mic) return 'none';
  if (state.micMuted || state.deafened) return 'off';
  return pushToTalk() ? 'ptt' : 'on';
}

/** Сообщаем собеседнику, выключен ли у нас микрофон и звук (сигнальным сообщением — сессия не нужна) */
function sendPresence() {
  if (state.signaling?.state !== 'open' || !state.peer) return;
  const presence = { mic: micPresence(), deafened: state.deafened };
  const key = JSON.stringify(presence);
  if (key === state.presenceSent) return;
  state.presenceSent = key;
  state.signaling.sendSignal({ kind: 'presence', ...presence }).then((sent) => {
    if (!sent) state.presenceSent = null; // не ушло — повторим при следующем изменении или подключении
  });
}

/** Как в Discord: включение микрофона при выключенном звуке включает и звук */
function toggleMic() {
  if (state.deafened) Object.assign(state, { deafened: false, micMuted: false });
  else state.micMuted = !state.micMuted;
  applyVoiceState();
}

function toggleDeafen() {
  state.deafened = !state.deafened;
  applyVoiceState();
}

// ======================= оверлей поверх игры =======================

const OVERLAY_MESSAGE_MS = 8000;

/** Микрофон и звук собеседника — строкой для оверлея */
function peerStateText() {
  const p = state.peerPresence;
  if (!p) return '';
  const parts = [];
  if (p.mic === 'off') parts.push('микрофон выключен');
  if (p.mic === 'none') parts.push('нет микрофона');
  if (p.mic === 'ptt') parts.push('рация');
  if (p.deafened) parts.push('не слышит');
  return parts.join(', ');
}

/** Состояние для оверлея (src/main/overlay.js) — 10 раз в секунду, пока подключены */
function publishOverlay() {
  const o = state.cfg.app.overlay;
  const active = o.enabled && Boolean(state.signaling);
  if (!active) {
    if (state.overlayActive) window.duo.overlay.update({ active: false });
    state.overlayActive = false;
    return;
  }
  state.overlayActive = true;
  const micOn = Boolean(state.mic) && !state.micMuted && !state.deafened;
  const ptt = micOn && pushToTalk();
  const mic = !state.mic
    ? 'нет микрофона'
    : state.deafened
      ? 'звук выключен'
      : state.micMuted
        ? 'микрофон выключен'
        : ptt
          ? state.pttHeld
            ? 'рация: в эфире'
            : 'рация'
          : 'микрофон включён';
  const voice = state.session?.remoteVoiceLevel() ?? 0;
  const v = state.stats?.video;
  const ping = state.stats?.rttMs != null ? ` · ${Math.round(state.stats.rttMs)} мс` : '';
  let stream = '';
  if (v) stream = `${v.direction === 'out' ? 'Стрим' : 'Смотрите'}: ${v.width}×${v.height} · ${Math.round(v.fps)} к/с · ${formatKbps(v.kbps)}${ping}`;
  else if (state.role === 'streamer' && state.screen) stream = 'Стрим запускается…';
  else if (state.peer) stream = `Голосовой чат${ping}`;
  else stream = state.role === 'streamer' ? 'Ожидание зрителя' : 'Ожидание стримера';
  const last = state.lastChat;
  window.duo.overlay.update({
    active,
    corner: o.corner,
    mic,
    micOff: !micOn,
    meSpeaking: micOn && (!ptt || state.pttHeld) && (state.mic?.level() ?? 0) > 0.35,
    peerName: state.peer?.name ?? null,
    peerSpeaking: !state.deafened && voice > 0 && 20 * Math.log10(voice) > -45,
    peerState: peerStateText(),
    deafened: state.deafened,
    stream,
    message: last && Date.now() - last.at < OVERLAY_MESSAGE_MS ? `${last.from}: ${last.text}` : null,
  });
}

// ======================= обновления =======================

function onUpdateState(update) {
  if (state.updateShown === update.version) return;
  if (update.status === 'ready') {
    state.updateShown = update.version;
    toast(`Скачано обновление ${update.version}. Установится, когда вы закроете DuoStream.`, 'ok', 0, {
      label: 'Перезапустить сейчас',
      onClick: () => window.duo.update.install(),
    });
  } else if (update.status === 'available') {
    state.updateShown = update.version;
    toast(`Вышла версия ${update.version} (у вас ${update.current}). Portable-версия сама не обновляется.`, 'info', 0, {
      label: 'Скачать',
      onClick: () => window.duo.update.install(),
    });
  }
}

function describeUpdate(u) {
  const status = {
    dev: 'не проверяются при запуске из исходников',
    off: 'проверка выключена в настройках',
    idle: 'ещё не проверялись',
    checking: 'проверка…',
    latest: 'установлена последняя',
    downloading: `скачивается ${u.version}: ${u.percent ?? 0}%`,
    ready: `${u.version} скачана, установится при выходе`,
    available: `вышла ${u.version} — ${u.url}`,
    error: `ошибка проверки: ${u.error}`,
  }[u.status];
  return `версия ${u.current}${u.portable ? ' (portable)' : ''} · ${status ?? u.status}`;
}

function onHotkey({ action, phase }) {
  const cue = (kind) => playCue(kind, state.cfg.audio.outputDeviceId);
  if (action === 'pushToTalk') {
    clearTimeout(state.pttTimer);
    if (phase === 'down') {
      state.pttHeld = true;
      applyVoiceState();
    } else {
      state.pttTimer = setTimeout(() => {
        state.pttHeld = false;
        applyVoiceState();
      }, state.cfg.audio.pushToTalkReleaseMs);
    }
    return;
  }
  if (phase !== 'down') return;
  if (action === 'toggleMute') {
    toggleMic();
    cue(state.micMuted ? 'off' : 'on');
  } else if (action === 'toggleDeafen') {
    toggleDeafen();
    cue(state.deafened ? 'deafen' : 'undeafen');
  } else if (action === 'toggleDenoise' && state.mic) {
    toggleDenoise().then(() => cue(state.mic?.denoiseWanted ? 'on' : 'off'));
  } else if (action === 'markGlitch') {
    markGlitch(true);
  } else if (action === 'toggleStream' && state.role === 'streamer' && state.signaling) {
    if (state.screen) {
      stopStream();
      cue('off');
    } else {
      // Источник выбирается в окне — показываем его поверх игры
      window.duo.focusWindow().then(startStream);
    }
  }
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
  const frameMs = (mic.frame / 48000) * 1000;
  const gate =
    mic.model === 'dfn3' && state.cfg.audio.voiceGate
      ? `, порог (${mic.vad ? 'Silero VAD' : 'по SNR'}) открыт ${Math.round(p.gateOpen * 100)}% времени`
      : '';
  return (
    `${DENOISE_MODELS[mic.model] ?? mic.model} · ${p.avgMs.toFixed(2)} мс на кадр ${frameMs} мс ` +
    `(макс ${p.maxMs.toFixed(1)}), пропусков ${p.underruns + p.dropped}${gate}`
  );
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
  logStatsIfNeeded(stats);
  if (state.role === 'streamer') {
    if (stats.video?.direction === 'out') state.session.noteEncodedFrame(stats.video.width, stats.video.height);
    checkEncoder(stats);
  }
}

/**
 * Сводка окна качества в журнал: раз в минуту, а сразу — когда изменилось то, что важно для разбора:
 * кодек или (де)кодер, разрешение, путь соединения, новые фризы, потери выше 2 %, просадка FPS на треть,
 * треск в звуке (приёмник досочиняет больше 2 % звука).
 */
function logStatsIfNeeded(stats) {
  const v = stats.video;
  const mark = {
    video: v ? `${v.codec} ${v.impl} ${v.hw} ${v.width}x${v.height}` : '',
    path: formatPath(stats.path),
    freezes: v?.freezes ?? 0,
    lossy: (v?.lossPct ?? 0) > 2,
    crackle: (stats.audio?.concealedPct ?? 0) > 2,
    fps: v?.fps ?? 0,
  };
  const last = state.statsLogged;
  const changed =
    !last ||
    last.video !== mark.video ||
    last.path !== mark.path ||
    mark.freezes > last.freezes ||
    (mark.lossy && !last.lossy) ||
    (mark.crackle && !last.crackle) ||
    mark.fps < last.fps * 0.67;
  if (!changed && Date.now() - state.statsLoggedAt < STATS_LOG_MS) return;
  state.statsLogged = mark;
  state.statsLoggedAt = Date.now();
  const counters = v ? ` | NACK ${v.nack ?? '—'}, PLI ${v.pli ?? '—'}` : '';
  console.log(`[stats] ${describeStats(stats, hudExtras()).map(([k, val]) => `${k}: ${val}`).join(' | ')}${counters}`);
}

/** Дополнительные строки окна качества (и сводки в журнале) */
function hudExtras() {
  const extra = { 'Голос собеседника': voiceSummary() };
  if (state.mic) extra['Шумодав'] = denoiseSummary();
  if (state.capture) extra['Захват'] = captureSummary();
  if (state.glitches) extra['Кадры-выбросы'] = glitchSummary();
  return extra;
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
    const extra = hudExtras();
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
  // Список разрешённых IP встроенный сервер принимает на лету, без переподключения
  if (state.hostedServer?.own && prev.signaling.allowedIps.join() !== cfg.signaling.allowedIps.join()) {
    const result = await window.duo.server.start(state.hostedServer.port, cfg.signaling.password, cfg.signaling.allowedIps);
    if (!result.ok) toast(`Список IP не применён: ${result.error}`, 'error', 8000);
  }
  if (prev.audio.outputDeviceId !== cfg.audio.outputDeviceId) {
    await applySink(state.playback.voice);
    await applySink(state.playback.system);
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
      if (state.session?.wouldGrowFrame(s.width * s.height)) await restartVideoEncoder('изменён размер захвата');
      sendStreamState();
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
  applyVoiceState(); // режим рации мог включиться или выключиться
}

async function collectDiagnostics() {
  const info = await window.duo.getAppInfo();
  const rows = [['Версии', `DuoStream ${info.versions.app} · Electron ${info.versions.electron} · Chromium ${info.versions.chrome}`]];
  const devices = info.gpu.devices;
  for (const g of devices) rows.push([g.active ? 'GPU (используется)' : 'GPU', `${g.vendor} ${g.description || g.deviceId}`]);
  if (info.gpu.renderer) rows.push(['Рендерер', info.gpu.renderer]);
  if (info.elevated) rows.push(['Внимание', 'Запущено от имени администратора: перетаскивание файлов из Проводника не работает']);
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
  rows.push(['Глобальные клавиши', info.hotkeys.available ? 'работают' : `недоступны: ${info.hotkeys.error}`]);
  rows.push(['Обновления', describeUpdate(info.update)]);
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
  const presence = state.peer ? state.peerPresence : null;
  const ptt = presence?.mic === 'ptt' ? ' · рация' : '';
  $('#peerName').textContent = state.peer ? `${ROLE_NAME[state.peer.role]}: ${state.peer.name}${ptt}` : '';
  $('#peerMicOff').hidden = !presence || !['off', 'none'].includes(presence.mic);
  $('#peerMicOff').title = presence?.mic === 'none' ? 'У собеседника нет микрофона' : 'У собеседника выключен микрофон';
  $('#peerDeafened').hidden = !presence?.deafened;

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
  $('#shareNote').textContent = share ? upnpNote() : '';

  // Кнопки
  const streamBtn = $('#btnStream');
  streamBtn.hidden = !(connected && streamer);
  streamBtn.classList.toggle('primary', !state.screen);
  streamBtn.classList.toggle('danger', Boolean(state.screen));
  setIcon(streamBtn.querySelector('i'), state.screen ? 'stop' : 'screen');
  streamBtn.querySelector('span').textContent = state.screen ? 'Остановить стрим' : 'Начать стрим';
  $('#btnDisconnect').hidden = !connected;

  const mic = state.mic;
  const keys = state.cfg.hotkeys;
  const keyHint = (action, fallback = '') => (keys[action] ? ` (${keys[action].label})` : fallback);
  const micOn = Boolean(mic) && !state.micMuted && !state.deafened;
  const micBtn = $('#btnMic');
  micBtn.disabled = !mic;
  micBtn.setAttribute('aria-pressed', String(micOn));
  // Рация: микрофон включён, но передаёт, только пока клавиша зажата
  micBtn.dataset.ptt = micOn && pushToTalk() ? (state.pttHeld ? 'talking' : 'idle') : '';
  micBtn.title = pushToTalk()
    ? `Рация: говорите, удерживая ${keys.pushToTalk.label}. Кнопка — выключить микрофон совсем`
    : `Микрофон${keyHint('toggleMute', ' (Ctrl+M)')}`;
  setIcon(micBtn.querySelector('i'), micOn ? 'mic' : 'micOff');

  const deafenBtn = $('#btnDeafen');
  deafenBtn.setAttribute('aria-pressed', String(!state.deafened));
  deafenBtn.title = `${state.deafened ? 'Звук выключен — включить' : 'Выключить звук собеседника'}${keyHint('toggleDeafen')}`;
  setIcon(deafenBtn.querySelector('i'), state.deafened ? 'headphonesOff' : 'headphones');

  const denoiseBtn = $('#btnDenoise');
  const ds = mic?.denoiseState ?? 'off';
  denoiseBtn.disabled = !mic;
  denoiseBtn.dataset.state = ds;
  denoiseBtn.setAttribute('aria-pressed', String(ds !== 'off'));
  $('#denoiseText').textContent = { on: 'Шумодав', off: 'Шумодав выкл', loading: 'Шумодав…', error: 'Шумодав: ошибка' }[ds];

  $('#streamVolumeWrap').hidden = streamer;
  $('#streamSendWrap').hidden = !streamer;
  // Отметка глюка — когда есть собеседник и идёт видео (у кого-то из двоих)
  $('#btnMarkGlitch').hidden = !state.peer || !(state.screen || state.remote?.live);
  chatPanel?.setAvailable(Boolean(state.peer));
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

const FULLSCREEN_IDLE_MS = 2500;

/**
 * Во весь экран — всё окно: верхняя панель прячется, нижняя висит поверх видео. Через 2,5 с без движения
 * мыши панель и курсор исчезают; движение мыши, клавиша или наведение на низ экрана возвращают их. Пока
 * курсор над панелью или открыт диалог — панель не прячется.
 */
function setupFullscreenIdle() {
  const controls = $('.controls');
  let timer = 0;
  let hovering = false;
  const busy = () => hovering || document.querySelector('dialog[open]');
  const hideLater = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!document.fullscreenElement) return;
      if (busy()) hideLater();
      else document.body.classList.add('idle');
    }, FULLSCREEN_IDLE_MS);
  };
  const wake = () => {
    document.body.classList.remove('idle');
    if (document.fullscreenElement) hideLater();
  };
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('fs', Boolean(document.fullscreenElement));
    wake();
  });
  document.addEventListener('mousemove', (e) => {
    // Подрагивание на 1–2 пикселя (стол, касание мыши) панель не будит
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2 || e.clientY > window.innerHeight - 80) wake();
  });
  document.addEventListener('mousedown', wake);
  document.addEventListener('keydown', wake);
  controls.addEventListener('mouseenter', () => (hovering = true));
  controls.addEventListener('mouseleave', () => {
    hovering = false;
    wake();
  });
}

/** Ползунки громкости (в процентах, выше 100 — усиление) и их запомненные значения */
function restoreVolumes() {
  const sliders = [
    ['voiceVolume', 'Голос собеседника', (v) => state.playback.voice.setVolume(v)],
    ['streamVolume', 'Звук трансляции', (v) => state.playback.system.setVolume(v)],
    // Стример: насколько громко звук игры/окна уходит зрителю
    ['streamSendVolume', 'Звук трансляции для зрителя', (v) => state.capture?.sendGain?.setVolume(v)],
  ];
  for (const [inputId, title, apply] of sliders) {
    const input = $(`#${inputId}`);
    try {
      const saved = localStorage.getItem(inputId);
      if (saved !== null) input.value = saved;
    } catch {
      // хранилище недоступно — оставляем значение по умолчанию
    }
    const update = () => {
      apply(Number(input.value) / 100);
      input.closest('label').title = `${title}: ${input.value}%`;
    };
    update();
    input.addEventListener('input', () => {
      update();
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
  $('#btnGenPassword').addEventListener('click', generatePassword);
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
  $('#btnDeafen').addEventListener('click', toggleDeafen);
  window.duo.hotkeys.onAction(onHotkey);
  window.duo.update.onState(onUpdateState);
  window.duo.onMainError((message) => toast(`Ошибка в главном процессе: ${message}`, 'error', 10000));
  window.duo.appAudio.onEnded((session, message) => {
    if (state.capture?.appAudio?.session === session) toast(`Звук окна прервался: ${message}`, 'warn', 8000);
  });
  $('#btnDenoise').addEventListener('click', toggleDenoise);
  $('#btnQuality').addEventListener('click', () => {
    state.hudOpen = !state.hudOpen;
    $('#hud').hidden = !state.hudOpen;
    renderQuality(state.stats);
  });
  $('#btnFullscreen').addEventListener('click', toggleFullscreen);
  $('#btnMarkGlitch').addEventListener('click', () => markGlitch(true));
  setupFullscreenIdle();
  $('#video').addEventListener('dblclick', toggleFullscreen);
  $('#btnSettings').addEventListener('click', () =>
    settingsDialog.open(state.cfg, state.configPath, { viewerIp: state.role === 'streamer' ? state.peer?.ip : null }),
  );
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
  chatPanel = new ChatPanel(state.chat, {
    peerName: () => state.peer?.name ?? 'Собеседник',
    canSend: () => Boolean(state.peer),
  });
  fillConnectForm();
  bindEvents();
  state.playback = { voice: new Playback($('#voiceAudio')), system: new Playback($('#systemAudio')) };
  restoreVolumes();
  refreshOutputs();
  render();
  setInterval(() => tickStats().catch((err) => console.warn('[stats]', err)), 1000);
  requestAnimationFrame(meterLoop);
  setInterval(publishOverlay, 100);
  // Запуск «от имени администратора» ломает перетаскивание файлов из Проводника — предупреждаем
  setTimeout(async () => {
    const info = await window.duo.getAppInfo().catch(() => null);
    if (info?.elevated) {
      toast(
        'DuoStream запущен от имени администратора — Windows не даёт перетаскивать в него файлы из Проводника. Запустите без прав администратора (или отправляйте файлы скрепкой в чате).',
        'warn',
        0,
      );
    }
  }, 3000);
  // Последнее входящее сообщение — в оверлей на несколько секунд
  state.chat.addEventListener('change', (e) => {
    const item = e.detail.item;
    if (item && !item.mine && (item.kind === 'msg' || item.status === 'offered')) {
      const text = item.kind === 'msg' ? item.text : `файл «${item.name}»`;
      state.lastChat = { from: state.peer?.name ?? 'Собеседник', text: text.slice(0, 200), at: Date.now() };
    }
  });
}

init().catch((err) => {
  console.error(err);
  toast(`Ошибка запуска интерфейса: ${err.message}`, 'error', 20000);
});
