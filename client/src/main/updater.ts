/**
 * Обновления из GitHub Releases — их публикует .github/workflows/release.yml при каждом пуше в master.
 *
 * Установленная версия (NSIS) скачивает обновление в фоне и ставит его при выходе из приложения
 * (или сразу — кнопкой в уведомлении). Portable-версия обновляться сама не умеет: она только
 * сообщает о новой версии и открывает страницу загрузки.
 * При запуске из исходников (npm start) обновления не проверяются.
 */
import { app, shell } from 'electron';
import type { AppUpdater } from 'electron-updater';
import type { UpdateState, UpdateStatus } from '../shared/duo-api';

const REPO = 'urjoonneighbor/duostream'; // тот же репозиторий, что build.publish в package.json
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

type State = Omit<UpdateState, 'current' | 'portable' | 'url'>;

export class Updater {
  private readonly send: (state: UpdateState) => void;
  private updater: AppUpdater | null = null;
  private timer: NodeJS.Timeout | null = null;
  private state: State = { status: app.isPackaged ? 'idle' : 'dev' };

  constructor(send: (state: UpdateState) => void) {
    this.send = send;
  }

  get portable(): boolean {
    return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
  }

  status(): UpdateState {
    return { ...this.state, current: app.getVersion(), portable: this.portable, url: RELEASES_URL };
  }

  /** @param enabled настройка app.autoUpdate */
  configure(enabled: boolean): void {
    if (!enabled || !app.isPackaged) {
      if (this.timer) clearInterval(this.timer);
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

  private createUpdater(): AppUpdater {
    // Загружается только в собранном приложении — при запуске из исходников модуль не нужен
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
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
    autoUpdater.on('error', (err: Error | undefined) => this.set({ status: 'error', error: err?.message ?? String(err) }));
    return autoUpdater;
  }

  private check(): void {
    // Ошибки (нет сети, GitHub недоступен) приходят событием 'error' — здесь их глушим
    this.updater?.checkForUpdates().catch(() => {});
  }

  private set(state: State & { status: UpdateStatus }): void {
    this.state = state;
    this.send(this.status());
  }

  /** Кнопка в уведомлении: перезапустить с новой версией или открыть страницу загрузки */
  install(): void {
    if (this.state.status === 'ready' && this.updater) this.updater.quitAndInstall(true, true);
    else void shell.openExternal(RELEASES_URL);
  }
}
