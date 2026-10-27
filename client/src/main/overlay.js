'use strict';
/**
 * Оверлей поверх игры: маленькое прозрачное окно в углу экрана — микрофон и звук, кто говорит,
 * состояние трансляции, последнее сообщение чата.
 *
 * Окно поверх всех, клики проходят сквозь него, фокус не забирает, в захват экрана не попадает
 * (setContentProtection → WDA_EXCLUDEFROMCAPTURE, Windows 10 2004+): ни в трансляцию, ни на скриншоты.
 * Показывается, пока окно DuoStream неактивно (вы в игре), и прячется, когда вы в нём.
 * Поверх игр в эксклюзивном полноэкранном режиме не виден (их кадр идёт мимо рабочего стола) —
 * в таких играх выбирайте «оконный без рамки»; в Windows 10/11 он обычно и так по умолчанию.
 */
const { BrowserWindow, screen } = require('electron');

const WIDTH = 300;
const HEIGHT = 190;
const MARGIN = 16;

class Overlay {
  /** @param {{preload:string, url:string}} options */
  constructor({ preload, url }) {
    this.preload = preload;
    this.url = url;
    this.win = null;
    this.main = null;
    this.state = null;
    this.corner = 'top-left';
  }

  /** Главное окно: оверлей виден, только пока оно не в фокусе */
  attachMainWindow(win) {
    this.main = win;
    for (const event of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide']) win.on(event, () => this.applyVisibility());
    win.on('closed', () => this.destroy());
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.loadURL(this.url);
    win.webContents.on('did-finish-load', () => this.state && win.webContents.send('overlay:state', this.state));
    this.win = win;
    return win;
  }

  /** @param {object} state от главного окна: {active, corner, …} */
  update(state) {
    this.state = state;
    if (state.corner && state.corner !== this.corner) {
      this.corner = state.corner;
      this.position();
    }
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('overlay:state', state);
    this.applyVisibility();
  }

  position() {
    if (!this.win || this.win.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const right = this.corner.endsWith('right');
    const bottom = this.corner.startsWith('bottom');
    this.win.setBounds({
      x: right ? area.x + area.width - WIDTH - MARGIN : area.x + MARGIN,
      y: bottom ? area.y + area.height - HEIGHT - MARGIN : area.y + MARGIN,
      width: WIDTH,
      height: HEIGHT,
    });
  }

  applyVisibility() {
    const mainActive = this.main && !this.main.isDestroyed() && this.main.isVisible() && !this.main.isMinimized() && this.main.isFocused();
    const want = Boolean(this.state?.active) && !mainActive;
    if (want) {
      const win = this.ensure();
      this.position();
      if (!win.isVisible()) win.showInactive();
    } else if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.win.hide();
    }
  }

  get visible() {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { Overlay };
