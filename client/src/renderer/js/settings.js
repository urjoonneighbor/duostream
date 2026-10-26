// Окно настроек: читает и правит копию stream.config.json.
import { $, renderList, toast } from './ui.js';
import { playTestTone } from './tones.js';

function setSelect(select, value, customLabel) {
  if (![...select.options].some((o) => o.value === value)) {
    select.append(new Option(customLabel ?? value, value));
  }
  select.value = value;
}

function fillDeviceSelect(select, devices, selected, fallbackName) {
  select.replaceChildren();
  devices.forEach((d, i) => select.append(new Option(d.label || `${fallbackName} ${i + 1}`, d.deviceId)));
  if (!devices.some((d) => d.deviceId === 'default')) select.prepend(new Option('По умолчанию', 'default'));
  select.value = devices.some((d) => d.deviceId === selected) ? selected : 'default';
}

const num = (id) => Number($(id).value);

export const HOTKEY_ACTIONS = [
  ['toggleMute', 'Микрофон вкл/выкл'],
  ['toggleDeafen', 'Звук вкл/выкл (не слышать собеседника, микрофон тоже выключается)'],
  ['pushToTalk', 'Рация — говорить, пока клавиша зажата'],
  ['toggleDenoise', 'Шумодав вкл/выкл'],
  ['toggleStream', 'Начать / остановить трансляцию (стример)'],
];

const sameBinding = (a, b) =>
  Boolean(a && b) &&
  a.key === b.key &&
  a.mouse === b.mouse &&
  ['ctrl', 'shift', 'alt', 'meta'].every((m) => Boolean(a[m]) === Boolean(b[m]));

export class SettingsDialog {
  /**
   * @param {{onSave:(cfg:object)=>Promise<void>, getDiagnostics:()=>Promise<Array<[string,string]>>}} options
   */
  constructor({ onSave, getDiagnostics }) {
    this.dialog = $('#settingsDialog');
    this.onSave = onSave;
    this.getDiagnostics = getDiagnostics;
    this.tabs = [...$('#settingsTabs').querySelectorAll('button')];
    this.tabs.forEach((b) => b.addEventListener('click', () => this.showTab(b.dataset.tab)));

    $('#btnSettingsCancel').addEventListener('click', () => this.dialog.close());
    for (const id of ['#sDenoise', '#sDenoiseModel']) $(id).addEventListener('change', () => this.updateDenoiseFields());
    $('#sAllowedIps').addEventListener('input', () => this.updateAllowViewer());
    $('#btnAllowViewer').addEventListener('click', () => {
      $('#sAllowedIps').value = [...this.allowedIpsInput(), this.viewerIp].join('\n');
      this.updateAllowViewer();
    });
    $('#btnTestOutput').addEventListener('click', async () => {
      const button = $('#btnTestOutput');
      button.disabled = true;
      try {
        await playTestTone($('#sOutput').value);
      } catch (err) {
        toast(`Не удалось вывести звук на это устройство: ${err.message}`, 'error');
      } finally {
        button.disabled = false;
      }
    });
    $('#hotkeyList').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (button) this.onHotkeyButton(button.dataset.action, button.dataset.role);
    });
    // Закрыли окно, пока ждали нажатия — перестаём ждать
    this.dialog.addEventListener('close', () => {
      if (this.recordingAction) window.duo.hotkeys.cancel();
    });
    // Esc во время назначения отменяет назначение, а не закрывает окно
    this.dialog.addEventListener('cancel', (event) => {
      if (this.recordingAction) event.preventDefault();
    });
    $('#btnOpenConfig').addEventListener('click', async () => {
      const error = await window.duo.openConfigFile();
      if (error) toast(`Не удалось открыть файл: ${error}`, 'error');
    });
    $('#settingsForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const save = $('#btnSettingsSave');
      save.disabled = true;
      try {
        await this.onSave(this.read());
        this.dialog.close();
      } catch (err) {
        toast(`Настройки не сохранены: ${err.message}`, 'error');
      } finally {
        save.disabled = false;
      }
    });
  }

  /** @param {{viewerIp?:string|null}} [context] viewerIp — адрес подключённого зрителя (у стримера) */
  async open(cfg, configPath, { viewerIp = null } = {}) {
    this.cfg = structuredClone(cfg);
    $('#sAllowedIps').value = this.cfg.signaling.allowedIps.join('\n');
    this.viewerIp = viewerIp;
    this.updateAllowViewer();
    const { video: v, audio: a, network: n, playback: p } = this.cfg;

    setSelect($('#sResolution'), `${v.width}x${v.height}`, `${v.width} × ${v.height}`);
    setSelect($('#sFps'), String(v.frameRate), `${v.frameRate} FPS`);
    $('#sBitrate').value = v.bitrateKbps;
    $('#sMinBitrate').value = v.minBitrateKbps;
    setSelect($('#sCodecs'), v.codecs.join(','), v.codecs.join(' → '));
    setSelect($('#sContentHint'), v.contentHint);
    setSelect($('#sDegradation'), v.degradationPreference);
    setSelect($('#sCaptureEngine'), v.captureEngine);
    $('#sPreferHw').checked = v.preferHardware;
    $('#sPreview').checked = v.showPreview;

    $('#sDenoise').checked = a.noiseSuppression;
    setSelect($('#sDenoiseModel'), a.denoiseModel);
    setSelect($('#sDenoiseLimit'), String(a.denoiseLimitDb), `до −${a.denoiseLimitDb} дБ`);
    $('#sVoiceGate').checked = a.voiceGate;
    this.updateDenoiseFields();
    $('#sEcho').checked = a.echoCancellation;
    $('#sAgc').checked = a.autoGainControl;
    $('#sVoiceBitrate').value = a.voiceBitrateKbps;
    $('#sSystemBitrate').value = a.systemAudioBitrateKbps;
    $('#sSystemAudio').checked = a.captureSystemAudio;
    $('#sPushToTalk').checked = a.pushToTalk;
    $('#sPttRelease').value = a.pushToTalkReleaseMs;
    this.recordingAction = null;
    this.renderHotkeys();

    $('#sStun').value = n.iceServers
      .filter((s) => !s.username)
      .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
      .join('\n');
    $('#sPortMin').value = n.udpPortRange.min;
    $('#sPortMax').value = n.udpPortRange.max;
    $('#sPublicIp').value = n.publicIp;
    $('#sTurnEnabled').checked = n.turn.enabled;
    $('#sTurnUrl').value = n.turn.urls;
    $('#sTurnUser').value = n.turn.username;
    $('#sTurnPass').value = n.turn.credential;
    $('#sForceRelay').checked = n.forceRelay;
    $('#sJitter').value = p.jitterBufferTargetMs;
    $('#sAutoUpdate').checked = this.cfg.app.autoUpdate;

    $('#configPath').textContent = configPath;
    $('#configPath').title = configPath;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      fillDeviceSelect($('#sMic'), devices.filter((d) => d.kind === 'audioinput'), a.micDeviceId, 'Микрофон');
      fillDeviceSelect($('#sOutput'), devices.filter((d) => d.kind === 'audiooutput'), a.outputDeviceId, 'Выход');
    } catch (err) {
      toast(`Не удалось получить список аудиоустройств: ${err.message}`, 'warn');
    }

    this.showTab('video');
    this.dialog.showModal();
  }

  renderHotkeys() {
    const rows = HOTKEY_ACTIONS.map(([action, title]) => {
      const binding = this.cfg.hotkeys[action];
      const recording = this.recordingAction === action;
      const row = document.createElement('div');
      row.className = 'hotkey-row';
      const name = document.createElement('span');
      name.textContent = title;
      const key = document.createElement('button');
      key.type = 'button';
      key.className = `key${recording ? ' recording' : ''}${binding ? '' : ' empty'}`;
      Object.assign(key.dataset, { action, role: 'assign' });
      key.textContent = recording ? 'Нажмите клавишу… (Esc — отмена)' : (binding?.label ?? 'Не назначено');
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'ghost icon-btn';
      clear.title = 'Убрать';
      clear.textContent = '✕';
      clear.disabled = !binding || recording;
      Object.assign(clear.dataset, { action, role: 'clear' });
      row.append(name, key, clear);
      return row;
    });
    $('#hotkeyList').replaceChildren(...rows);
  }

  async onHotkeyButton(action, role) {
    if (role === 'clear') {
      this.cfg.hotkeys[action] = null;
      this.renderHotkeys();
      return;
    }
    if (this.recordingAction) {
      window.duo.hotkeys.cancel(); // повторный клик — отмена
      return;
    }
    this.recordingAction = action;
    this.renderHotkeys();
    // Иначе Пробел/Enter, которые назначают, ещё и «нажмут» кнопку в окне
    document.activeElement?.blur();
    try {
      const result = await window.duo.hotkeys.record();
      if (result?.cleared) this.cfg.hotkeys[action] = null;
      if (result?.binding) {
        // Одна клавиша — одно действие
        for (const [other, title] of HOTKEY_ACTIONS) {
          if (other !== action && sameBinding(this.cfg.hotkeys[other], result.binding)) {
            this.cfg.hotkeys[other] = null;
            toast(`${result.binding.label} снята с действия «${title}»`, 'info');
          }
        }
        this.cfg.hotkeys[action] = result.binding;
      }
    } catch (err) {
      toast(`Горячие клавиши недоступны: ${err.message}`, 'error');
    } finally {
      this.recordingAction = null;
      this.renderHotkeys();
    }
  }

  allowedIpsInput() {
    return [...new Set($('#sAllowedIps').value.split(/[\s,;]+/).filter(Boolean))];
  }

  /** Подсказка «Подключён зритель с … — Добавить», если его адреса ещё нет в списке */
  updateAllowViewer() {
    const ip = this.viewerIp;
    const show = Boolean(ip) && !/^(127\.|::1$)/.test(ip) && !this.allowedIpsInput().includes(ip);
    $('#allowViewerRow').hidden = !show;
    if (show) $('#allowViewerText').textContent = `Сейчас подключён зритель с ${ip}`;
  }

  /** Сила подавления и голосовой порог есть только у DeepFilterNet3 */
  updateDenoiseFields() {
    const on = $('#sDenoise').checked;
    const dfn = $('#sDenoiseModel').value === 'dfn3';
    $('#sDenoiseModel').disabled = !on;
    $('#sDenoiseLimit').disabled = !on || !dfn;
    $('#sVoiceGate').disabled = !on || !dfn;
  }

  showTab(name) {
    this.tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    for (const panel of this.dialog.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
    if (name === 'diag') this.refreshDiagnostics();
    if (name === 'keys') {
      window.duo.getAppInfo().then(({ hotkeys }) => {
        $('#hotkeyStatus').textContent = hotkeys.available
          ? ''
          : `Глобальные клавиши недоступны: ${hotkeys.error}. В окне работает Ctrl+M (микрофон).`;
      });
    }
  }

  async refreshDiagnostics() {
    renderList($('#diagList'), [['', 'Собираю данные…']]);
    try {
      renderList($('#diagList'), await this.getDiagnostics());
    } catch (err) {
      renderList($('#diagList'), [['Ошибка', err.message]]);
    }
  }

  read() {
    const cfg = structuredClone(this.cfg);
    const [width, height] = $('#sResolution').value.split('x').map(Number);
    Object.assign(cfg.video, {
      width,
      height,
      frameRate: num('#sFps'),
      bitrateKbps: num('#sBitrate'),
      minBitrateKbps: num('#sMinBitrate'),
      codecs: $('#sCodecs').value.split(','),
      contentHint: $('#sContentHint').value,
      degradationPreference: $('#sDegradation').value,
      captureEngine: $('#sCaptureEngine').value,
      preferHardware: $('#sPreferHw').checked,
      showPreview: $('#sPreview').checked,
    });
    Object.assign(cfg.audio, {
      micDeviceId: $('#sMic').value || 'default',
      outputDeviceId: $('#sOutput').value || 'default',
      noiseSuppression: $('#sDenoise').checked,
      denoiseModel: $('#sDenoiseModel').value,
      denoiseLimitDb: num('#sDenoiseLimit'),
      voiceGate: $('#sVoiceGate').checked,
      echoCancellation: $('#sEcho').checked,
      autoGainControl: $('#sAgc').checked,
      voiceBitrateKbps: num('#sVoiceBitrate'),
      systemAudioBitrateKbps: num('#sSystemBitrate'),
      captureSystemAudio: $('#sSystemAudio').checked,
      pushToTalk: $('#sPushToTalk').checked,
      pushToTalkReleaseMs: num('#sPttRelease'),
    });
    const stun = $('#sStun')
      .value.split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    cfg.network.iceServers = [...(stun.length ? [{ urls: stun }] : []), ...this.cfg.network.iceServers.filter((s) => s.username)];
    cfg.network.udpPortRange = { min: num('#sPortMin'), max: num('#sPortMax') };
    cfg.network.publicIp = $('#sPublicIp').value.trim();
    cfg.signaling.allowedIps = this.allowedIpsInput();
    cfg.network.turn = {
      enabled: $('#sTurnEnabled').checked,
      urls: $('#sTurnUrl').value.trim(),
      username: $('#sTurnUser').value.trim(),
      credential: $('#sTurnPass').value,
    };
    cfg.network.forceRelay = $('#sForceRelay').checked;
    cfg.playback.jitterBufferTargetMs = num('#sJitter');
    cfg.app.autoUpdate = $('#sAutoUpdate').checked;
    return cfg;
  }
}
