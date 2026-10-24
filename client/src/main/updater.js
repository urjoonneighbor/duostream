'use strict';
/**
 * Обновления из GitHub Releases — их публикует .github/workflows/release.yml при каждом пуше в master.
 *
 * Установленная версия (NSIS) скачивает обновление в фоне и ставит его при выходе из приложения
 * (или сразу — кнопкой в уведомлении). Portable-версия обновляться сама не умеет: она только
 * сообщает о новой версии и открывает страницу загрузки.
 * При запуске из исходников (npm start) обновления не проверяются.
 */
const { app, shell } = require('electron');

const REPO = 'urjoonneighbor/duostream'; // тот же репозиторий, что build.publish в package.json
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

class Updater {
  /** @param {(state:object) => void} send */
  constructor(send) {
    this.send = send;
    this.updater = null;
    this.timer = null;
    this.state = { status: app.isPackaged ? 'idle' : 'dev' };
  }

  get portable() {
    return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
  }

  status() {
    return { ...this.state, current: app.getVersion(), portable: this.portable, url: RELEASES_URL };
  }

  /** @param {boolean} enabled настройка app.autoUpdate */
  configure(enabled) {
    if (!enabled || !app.isPackaged) {
      clearInterval(this.timer);
      this.timer = null;
      if (app.isPackaged) this.set({ status: 'off' });
      return;
    }
    if (!this.updater) this.updater = this.createUpdater();
    if (!this.timer) {
      this.check();
      this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    }
  }

  createUpdater() {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = !this.portable;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'latest' }));
    autoUpdater.on('update-available', (info) =>
      this.set({ status: this.portable ? 'available' : 'downloading', version: info.version, percent: 0 }),
    );
    autoUpdater.on('download-progress', (p) => {
      const percent = Math.floor(p.percent);
      if (percent !== this.state.percent) this.set({ ...this.state, status: 'downloading', percent });
    });
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => this.set({ status: 'error', error: err?.message ?? String(err) }));
    return autoUpdater;
  }

  check() {
    // Ошибки (нет сети, GitHub недоступен) приходят событием 'error' — здесь их глушим
    this.updater?.checkForUpdates().catch(() => {});
  }

  set(state) {
    this.state = state;
    this.send(this.status());
  }

  /** Кнопка в уведомлении: перезапустить с новой версией или открыть страницу загрузки */
  install() {
    if (this.state.status === 'ready') this.updater.quitAndInstall(true, true);
    else shell.openExternal(RELEASES_URL);
  }
}

module.exports = { Updater };
