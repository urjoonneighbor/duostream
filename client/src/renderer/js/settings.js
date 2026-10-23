// Окно настроек: читает и правит копию stream.config.json.
import { $, renderList, toast } from './ui.js';

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

  async open(cfg, configPath) {
    this.cfg = structuredClone(cfg);
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
    $('#sEcho').checked = a.echoCancellation;
    $('#sAgc').checked = a.autoGainControl;
    $('#sVoiceBitrate').value = a.voiceBitrateKbps;
    $('#sSystemBitrate').value = a.systemAudioBitrateKbps;
    $('#sSystemAudio').checked = a.captureSystemAudio;

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

  showTab(name) {
    this.tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    for (const panel of this.dialog.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
    if (name === 'diag') this.refreshDiagnostics();
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
      echoCancellation: $('#sEcho').checked,
      autoGainControl: $('#sAgc').checked,
      voiceBitrateKbps: num('#sVoiceBitrate'),
      systemAudioBitrateKbps: num('#sSystemBitrate'),
      captureSystemAudio: $('#sSystemAudio').checked,
    });
    const stun = $('#sStun')
      .value.split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    cfg.network.iceServers = [...(stun.length ? [{ urls: stun }] : []), ...this.cfg.network.iceServers.filter((s) => s.username)];
    cfg.network.udpPortRange = { min: num('#sPortMin'), max: num('#sPortMax') };
    cfg.network.publicIp = $('#sPublicIp').value.trim();
    cfg.network.turn = {
      enabled: $('#sTurnEnabled').checked,
      urls: $('#sTurnUrl').value.trim(),
      username: $('#sTurnUser').value.trim(),
      credential: $('#sTurnPass').value,
    };
    cfg.network.forceRelay = $('#sForceRelay').checked;
    cfg.playback.jitterBufferTargetMs = num('#sJitter');
    return cfg;
  }
}
