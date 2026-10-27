'use strict';
/**
 * Значок в трее. Крестик окна не выходит из приложения, а прячет окно в трей: звонок, трансляция,
 * горячие клавиши и оверлей продолжают работать. Об этом при первом закрытии за запуск предупреждает
 * всплывающее уведомление. Выход — «Выйти» в меню значка.
 */
const { Menu, Tray, nativeImage } = require('electron');

class AppTray {
  /** @param {{icon: string, onQuit: () => void}} options */
  constructor({ icon, onQuit }) {
    this.icon = icon;
    this.onQuit = onQuit;
    this.tray = null;
    this.win = null;
    this.quitting = false;
    this.warned = false;
  }

  create() {
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

  /** @param {Electron.BrowserWindow} win */
  attach(win) {
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

  show() {
    const win = this.win;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  destroy() {
    this.tray?.destroy();
    this.tray = null;
  }
}

module.exports = { AppTray };
