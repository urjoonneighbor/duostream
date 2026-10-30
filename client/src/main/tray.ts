/**
 * Значок в трее. Крестик окна не выходит из приложения, а прячет окно в трей: звонок, трансляция,
 * горячие клавиши и оверлей продолжают работать. Об этом при первом закрытии за запуск предупреждает
 * всплывающее уведомление. Выход — «Выйти» в меню значка.
 */
import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron';

export class AppTray {
  private readonly icon: string;
  private readonly onQuit: () => void;
  private tray: Tray | null = null;
  private win: BrowserWindow | null = null;
  quitting = false;
  private warned = false;

  constructor({ icon, onQuit }: { icon: string; onQuit: () => void }) {
    this.icon = icon;
    this.onQuit = onQuit;
  }

  create(): void {
    if (this.tray) return;
    this.tray = new Tray(nativeImage.createFromPath(this.icon).resize({ width: 32, height: 32, quality: 'best' }));
    this.tray.setToolTip('DuoStream');
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Открыть DuoStream', click: () => this.show() },
        { type: 'separator' },
        { label: 'Выйти', click: () => this.onQuit() },
      ]),
    );
    this.tray.on('click', () => this.show());
  }

  attach(win: BrowserWindow): void {
    this.win = win;
    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      win.hide();
      if (this.warned) return;
      this.warned = true;
      this.tray?.displayBalloon({
        iconType: 'info',
        title: 'DuoStream свёрнут в трей',
        content: 'Звонок и трансляция продолжаются. Чтобы выйти, щёлкните значок правой кнопкой → «Выйти».',
      });
    });
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
  }

  show(): void {
    const win = this.win;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
