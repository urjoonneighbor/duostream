// Окно настроек: читает и правит копию stream.config.json.
import { $, renderList, toast } from './ui.ts';
import { playTestTone } from './tones.ts';
import type { Config, HotkeyAction, HotkeyBinding } from '../../shared/config';
import type { Row } from './stats.ts';

function setSelect(select: HTMLSelectElement, value: string, customLabel?: string): void {
  if (![...select.options].some((o) => o.value === value)) {
    select.append(new Option(customLabel ?? value, value));
  }
  select.value = value;
}

function fillDeviceSelect(select: HTMLSelectElement, devices: MediaDeviceInfo[], selected: string, fallbackName: string): void {
  select.replaceChildren();
  devices.forEach((d, i) => select.append(new Option(d.label || `${fallbackName} ${i + 1}`, d.deviceId)));
  if (!devices.some((d) => d.deviceId === 'default')) select.prepend(new Option('По умолчанию', 'default'));
  select.value = devices.some((d) => d.deviceId === selected) ? selected : 'default';
}

const num = (id: string) => Number($<HTMLInputElement>(id).value);

export const HOTKEY_ACTIONS: [HotkeyAction, string][] = [
  ['toggleMute', 'Микрофон вкл/выкл'],
  ['toggleDeafen', 'Звук вкл/выкл (не слышать собеседника, микрофон тоже выключается)'],
  ['pushToTalk', 'Рация — говорить, пока клавиша зажата'],
  ['toggleDenoise', 'Шумодав вкл/выкл'],
  ['toggleStream', 'Начать / остановить трансляцию (стример)'],
  ['markGlitch', 'Отметить глюк картинки — сохранить последние 2 с кадров у обоих'],
];

const sameBinding = (a: HotkeyBinding | null, b: HotkeyBinding | null) =>
  Boolean(a && b) &&
  a!.key === b!.key &&
  a!.mouse === b!.mouse &&
  (['ctrl', 'shift', 'alt', 'meta'] as const).every((m) => Boolean(a![m]) === Boolean(b![m]));

export class SettingsDialog {
  private readonly dialog = $<HTMLDialogElement>('#settingsDialog');
  private readonly onSave: (cfg: Config) => Promise<void>;
  private readonly getDiagnostics: () => Promise<Row[]>;
  private readonly tabs: HTMLButtonElement[];
  private cfg!: Config;
  private viewerIp: string | null = null;
  private recordingAction: HotkeyAction | null = null;

  constructor({ onSave, getDiagnostics }: { onSave: (cfg: Config) => Promise<void>; getDiagnostics: () => Promise<Row[]> }) {
    this.onSave = onSave;
    this.getDiagnostics = getDiagnostics;
    this.tabs = [...$('#settingsTabs').querySelectorAll('button')];
    this.tabs.forEach((b) => b.addEventListener('click', () => this.showTab(b.dataset.tab ?? 'video')));

    $('#btnSettingsCancel').addEventListener('click', () => this.dialog.close());
    for (const id of ['#sDenoise', '#sDenoiseModel']) $(id).addEventListener('change', () => this.updateDenoiseFields());
    $<HTMLInputElement>('#sAllowedIps').addEventListener('input', () => this.updateAllowViewer());
    $('#btnAllowViewer').addEventListener('click', () => {
      $<HTMLInputElement>('#sAllowedIps').value = [...this.allowedIpsInput(), this.viewerIp ?? ''].join('\n');
      this.updateAllowViewer();
    });
    $('#btnTestOutput').addEventListener('click', async () => {
      const button = $<HTMLButtonElement>('#btnTestOutput');
      button.disabled = true;
      try {
        await playTestTone($<HTMLInputElement>('#sOutput').value);
      } catch (err) {
        toast(`Не удалось вывести звук на это устройство: ${(err as Error).message}`, 'error');
      } finally {
        button.disabled = false;
      }
    });
    $('#hotkeyList').addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]');
      if (button) void this.onHotkeyButton(button.dataset.action as HotkeyAction, button.dataset.role ?? '');
    });
    // Закрыли окно, пока ждали нажатия — перестаём ждать
    this.dialog.addEventListener('close', () => {
      if (this.recordingAction) void window.duo.hotkeys.cancel();
    });
    // Esc во время назначения отменяет назначение, а не закрывает окно
    this.dialog.addEventListener('cancel', (event) => {
      if (this.recordingAction) event.preventDefault();
    });
    $('#btnRevealLog').addEventListener('click', () => void window.duo.revealLog());
    $('#btnOpenConfig').addEventListener('click', async () => {
      const error = await window.duo.openConfigFile();
      if (error) toast(`Не удалось открыть файл: ${error}`, 'error');
    });
    $('#settingsForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const save = $<HTMLButtonElement>('#btnSettingsSave');
      save.disabled = true;
      try {
        await this.onSave(this.read());
        this.dialog.close();
      } catch (err) {
        toast(`Настройки не сохранены: ${(err as Error).message}`, 'error');
      } finally {
        save.disabled = false;
      }
    });
  }

  /** @param viewerIp адрес подключённого зрителя (у стримера) */
  async open(cfg: Config, configPath: string, { viewerIp = null }: { viewerIp?: string | null } = {}): Promise<void> {
    this.cfg = structuredClone(cfg);
    $<HTMLInputElement>('#sAllowedIps').value = this.cfg.signaling.allowedIps.join('\n');
    this.viewerIp = viewerIp;
    this.updateAllowViewer();
    const { video: v, audio: a, network: n, playback: p } = this.cfg;

    setSelect($<HTMLSelectElement>('#sResolution'), `${v.width}x${v.height}`, `${v.width} × ${v.height}`);
    setSelect($<HTMLSelectElement>('#sFps'), String(v.frameRate), `${v.frameRate} FPS`);
    $<HTMLInputElement>('#sBitrate').value = String(v.bitrateKbps);
    $<HTMLInputElement>('#sMinBitrate').value = String(v.minBitrateKbps);
    setSelect($<HTMLSelectElement>('#sCodecs'), v.codecs.join(','), v.codecs.join(' → '));
    setSelect($<HTMLSelectElement>('#sContentHint'), v.contentHint);
    setSelect($<HTMLSelectElement>('#sDegradation'), v.degradationPreference);
    setSelect($<HTMLSelectElement>('#sCaptureEngine'), v.captureEngine);
    $<HTMLInputElement>('#sPreferHw').checked = v.preferHardware;
    $<HTMLInputElement>('#sPreview').checked = v.showPreview;
    setSelect($<HTMLSelectElement>('#sRenderer'), v.renderer);

    $<HTMLInputElement>('#sDenoise').checked = a.noiseSuppression;
    setSelect($<HTMLSelectElement>('#sDenoiseModel'), a.denoiseModel);
    setSelect($<HTMLSelectElement>('#sDenoiseLimit'), String(a.denoiseLimitDb), `до −${a.denoiseLimitDb} дБ`);
    $<HTMLInputElement>('#sVoiceGate').checked = a.voiceGate;
    this.updateDenoiseFields();
    $<HTMLInputElement>('#sEcho').checked = a.echoCancellation;
    $<HTMLInputElement>('#sAgc').checked = a.autoGainControl;
    $<HTMLInputElement>('#sVoiceBitrate').value = String(a.voiceBitrateKbps);
    $<HTMLInputElement>('#sSystemBitrate').value = String(a.systemAudioBitrateKbps);
    $<HTMLInputElement>('#sSystemAudio').checked = a.captureSystemAudio;
    $<HTMLInputElement>('#sPushToTalk').checked = a.pushToTalk;
    $<HTMLInputElement>('#sUiSounds').checked = a.uiSounds;
    $<HTMLInputElement>('#sPttRelease').value = String(a.pushToTalkReleaseMs);
    this.recordingAction = null;
    this.renderHotkeys();

    $<HTMLInputElement>('#sStun').value = n.iceServers
      .filter((s) => !s.username)
      .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
      .join('\n');
    $<HTMLInputElement>('#sPortMin').value = String(n.udpPortRange.min);
    $<HTMLInputElement>('#sPortMax').value = String(n.udpPortRange.max);
    $<HTMLInputElement>('#sPublicIp').value = n.publicIp;
    $<HTMLInputElement>('#sUpnp').checked = n.upnp;
    $<HTMLInputElement>('#sTurnEnabled').checked = n.turn.enabled;
    $<HTMLInputElement>('#sTurnUrl').value = n.turn.urls;
    $<HTMLInputElement>('#sTurnUser').value = n.turn.username;
    $<HTMLInputElement>('#sTurnPass').value = n.turn.credential;
    $<HTMLInputElement>('#sForceRelay').checked = n.forceRelay;
    $<HTMLInputElement>('#sJitter').value = String(p.streamBufferMs);
    $<HTMLInputElement>('#sAutoUpdate').checked = this.cfg.app.autoUpdate;
    $<HTMLInputElement>('#sOverlay').checked = this.cfg.app.overlay.enabled;
    setSelect($<HTMLSelectElement>('#sOverlayCorner'), this.cfg.app.overlay.corner);

    $('#configPath').textContent = configPath;
    $('#configPath').title = configPath;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      fillDeviceSelect($<HTMLSelectElement>('#sMic'), devices.filter((d) => d.kind === 'audioinput'), a.micDeviceId, 'Микрофон');
      fillDeviceSelect($<HTMLSelectElement>('#sOutput'), devices.filter((d) => d.kind === 'audiooutput'), a.outputDeviceId, 'Выход');
    } catch (err) {
      toast(`Не удалось получить список аудиоустройств: ${(err as Error).message}`, 'warn');
    }

    this.showTab('video');
    this.dialog.showModal();
  }

  private renderHotkeys(): void {
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

  private async onHotkeyButton(action: HotkeyAction, role: string): Promise<void> {
    if (role === 'clear') {
      this.cfg.hotkeys[action] = null;
      this.renderHotkeys();
      return;
    }
    if (this.recordingAction) {
      void window.duo.hotkeys.cancel(); // повторный клик — отмена
      return;
    }
    this.recordingAction = action;
    this.renderHotkeys();
    // Иначе Пробел/Enter, которые назначают, ещё и «нажмут» кнопку в окне
    (document.activeElement as HTMLElement | null)?.blur();
    try {
      const result = await window.duo.hotkeys.record();
      if (result && 'cleared' in result) this.cfg.hotkeys[action] = null;
      if (result && 'binding' in result) {
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
      toast(`Горячие клавиши недоступны: ${(err as Error).message}`, 'error');
    } finally {
      this.recordingAction = null;
      this.renderHotkeys();
    }
  }

  private allowedIpsInput(): string[] {
    return [...new Set($<HTMLInputElement>('#sAllowedIps').value.split(/[\s,;]+/).filter(Boolean))];
  }

  /** Подсказка «Подключён зритель с … — Добавить», если его адреса ещё нет в списке */
  private updateAllowViewer(): void {
    const ip = this.viewerIp ?? '';
    const show = Boolean(ip) && !/^(127\.|::1$)/.test(ip) && !this.allowedIpsInput().includes(ip);
    $('#allowViewerRow').hidden = !show;
    if (show) $('#allowViewerText').textContent = `Сейчас подключён зритель с ${ip}`;
  }

  /** Сила подавления и голосовой порог есть только у DeepFilterNet3 */
  private updateDenoiseFields(): void {
    const on = $<HTMLInputElement>('#sDenoise').checked;
    const dfn = $<HTMLInputElement>('#sDenoiseModel').value === 'dfn3';
    $<HTMLInputElement>('#sDenoiseModel').disabled = !on;
    $<HTMLInputElement>('#sDenoiseLimit').disabled = !on || !dfn;
    $<HTMLInputElement>('#sVoiceGate').disabled = !on || !dfn;
  }

  private showTab(name: string): void {
    this.tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    for (const panel of this.dialog.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
    if (name === 'diag') void this.refreshDiagnostics();
    if (name === 'keys') {
      void window.duo.getAppInfo().then(({ hotkeys }) => {
        $('#hotkeyStatus').textContent = hotkeys.available
          ? ''
          : `Глобальные клавиши недоступны: ${hotkeys.error}. В окне работает Ctrl+M (микрофон).`;
      });
    }
  }

  private async refreshDiagnostics(): Promise<void> {
    renderList($('#diagList'), [['', 'Собираю данные…']]);
    try {
      renderList($('#diagList'), await this.getDiagnostics());
    } catch (err) {
      renderList($('#diagList'), [['Ошибка', (err as Error).message]]);
    }
  }

  private read(): Config {
    const cfg = structuredClone(this.cfg);
    const [width, height] = $<HTMLInputElement>('#sResolution').value.split('x').map(Number);
    Object.assign(cfg.video, {
      width,
      height,
      frameRate: num('#sFps'),
      bitrateKbps: num('#sBitrate'),
      minBitrateKbps: num('#sMinBitrate'),
      codecs: $<HTMLInputElement>('#sCodecs').value.split(',') as Config['video']['codecs'],
      contentHint: $<HTMLInputElement>('#sContentHint').value,
      degradationPreference: $<HTMLInputElement>('#sDegradation').value,
      captureEngine: $<HTMLInputElement>('#sCaptureEngine').value,
      preferHardware: $<HTMLInputElement>('#sPreferHw').checked,
      showPreview: $<HTMLInputElement>('#sPreview').checked,
      renderer: $<HTMLInputElement>('#sRenderer').value,
    });
    Object.assign(cfg.audio, {
      micDeviceId: $<HTMLInputElement>('#sMic').value || 'default',
      outputDeviceId: $<HTMLInputElement>('#sOutput').value || 'default',
      noiseSuppression: $<HTMLInputElement>('#sDenoise').checked,
      denoiseModel: $<HTMLInputElement>('#sDenoiseModel').value,
      denoiseLimitDb: num('#sDenoiseLimit'),
      voiceGate: $<HTMLInputElement>('#sVoiceGate').checked,
      echoCancellation: $<HTMLInputElement>('#sEcho').checked,
      autoGainControl: $<HTMLInputElement>('#sAgc').checked,
      voiceBitrateKbps: num('#sVoiceBitrate'),
      systemAudioBitrateKbps: num('#sSystemBitrate'),
      captureSystemAudio: $<HTMLInputElement>('#sSystemAudio').checked,
      pushToTalk: $<HTMLInputElement>('#sPushToTalk').checked,
      uiSounds: $<HTMLInputElement>('#sUiSounds').checked,
      pushToTalkReleaseMs: num('#sPttRelease'),
    });
    const stun = $<HTMLInputElement>('#sStun')
      .value.split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    cfg.network.iceServers = [...(stun.length ? [{ urls: stun }] : []), ...this.cfg.network.iceServers.filter((s) => s.username)];
    cfg.network.udpPortRange = { min: num('#sPortMin'), max: num('#sPortMax') };
    cfg.network.publicIp = $<HTMLInputElement>('#sPublicIp').value.trim();
    cfg.network.upnp = $<HTMLInputElement>('#sUpnp').checked;
    cfg.signaling.allowedIps = this.allowedIpsInput();
    cfg.network.turn = {
      enabled: $<HTMLInputElement>('#sTurnEnabled').checked,
      urls: $<HTMLInputElement>('#sTurnUrl').value.trim(),
      username: $<HTMLInputElement>('#sTurnUser').value.trim(),
      credential: $<HTMLInputElement>('#sTurnPass').value,
    };
    cfg.network.forceRelay = $<HTMLInputElement>('#sForceRelay').checked;
    cfg.playback.streamBufferMs = num('#sJitter');
    cfg.app.autoUpdate = $<HTMLInputElement>('#sAutoUpdate').checked;
    cfg.app.overlay = { enabled: $<HTMLInputElement>('#sOverlay').checked, corner: $<HTMLInputElement>('#sOverlayCorner').value as Config['app']['overlay']['corner'] };
    return cfg;
  }
}
