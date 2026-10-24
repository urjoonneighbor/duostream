'use strict';
/**
 * Глобальные горячие клавиши: работают, когда окно свёрнуто и в фокусе игра.
 *
 * Низкоуровневый хук клавиатуры и мыши (uiohook-napi) только наблюдает за нажатиями и не забирает
 * их у других программ — как в Discord. В отличие от globalShortcut Electron, видно и нажатие,
 * и отпускание (нужно для режима рации), и боковые кнопки мыши.
 *
 * Привязка: { key?: код uiohook, mouse?: 3–5, ctrl, shift, alt, meta, label }.
 */
let uiohook = null;
let loadError = '';
try {
  uiohook = require('uiohook-napi');
} catch (err) {
  loadError = err.message;
}

const KEY = uiohook?.UiohookKey ?? {};
const MODIFIERS = new Set([KEY.Ctrl, KEY.CtrlRight, KEY.Shift, KEY.ShiftRight, KEY.Alt, KEY.AltRight, KEY.Meta, KEY.MetaRight]);
const KEY_NAMES = Object.fromEntries(Object.entries(KEY).map(([name, code]) => [code, name]));
const PRETTY = {
  Ctrl: 'Левый Ctrl',
  CtrlRight: 'Правый Ctrl',
  Shift: 'Левый Shift',
  ShiftRight: 'Правый Shift',
  Alt: 'Левый Alt',
  AltRight: 'Правый Alt',
  Meta: 'Win',
  MetaRight: 'Правый Win',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Пробел',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};
const MOUSE_NAMES = { 3: 'Средняя кнопка мыши', 4: 'Мышь 4 (назад)', 5: 'Мышь 5 (вперёд)' };
const RECORD_TIMEOUT_MS = 15_000;

function bindingLabel(b) {
  if (b.mouse) return [...modifierNames(b), MOUSE_NAMES[b.mouse] ?? `Мышь ${b.mouse}`].join(' + ');
  const name = KEY_NAMES[b.key];
  return [...modifierNames(b), PRETTY[name] ?? name?.replace(/^Numpad/, 'Num ') ?? `Клавиша ${b.key}`].join(' + ');
}

function modifierNames(b) {
  return [b.ctrl && 'Ctrl', b.shift && 'Shift', b.alt && 'Alt', b.meta && 'Win'].filter(Boolean);
}

const sameInput = (b, input) => (input.mouse ? b.mouse === input.mouse : b.key === input.key);

class Hotkeys {
  /** @param {(action:string, phase:'down'|'up') => void} onAction */
  constructor(onAction) {
    this.onAction = onAction;
    this.bindings = {};
    this.pressed = new Set();
    this.recording = null;
    this.started = false;
  }

  status() {
    return { available: Boolean(uiohook), error: loadError };
  }

  /** Новые привязки из stream.config.json → hotkeys */
  update(bindings) {
    this.bindings = { ...bindings };
    this.pressed.clear();
    if (Object.values(this.bindings).some(Boolean)) this.start();
  }

  start() {
    if (this.started || !uiohook) return;
    const { uIOhook } = uiohook;
    uIOhook.on('keydown', (e) => this.onDown({ key: e.keycode }, e));
    uIOhook.on('keyup', (e) => this.onUp({ key: e.keycode }));
    uIOhook.on('mousedown', (e) => this.onDown({ mouse: e.button }, e));
    uIOhook.on('mouseup', (e) => this.onUp({ mouse: e.button }));
    uIOhook.start();
    this.started = true;
  }

  stop() {
    if (this.started) uiohook.uIOhook.stop();
    this.started = false;
  }

  /**
   * Ждёт следующее нажатие и возвращает привязку: {binding} — назначить, {cleared:true} — Backspace/Delete
   * (убрать), null — Esc или 15 с без нажатий.
   */
  record() {
    if (!uiohook) return Promise.reject(new Error(loadError || 'uiohook-napi не загружен'));
    this.cancelRecord();
    this.start();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishRecord(null), RECORD_TIMEOUT_MS);
      this.recording = { resolve, timer, modifier: null };
    });
  }

  cancelRecord() {
    this.finishRecord(null);
  }

  finishRecord(result) {
    const rec = this.recording;
    if (!rec) return;
    this.recording = null;
    clearTimeout(rec.timer);
    if (result?.binding) result.binding.label = bindingLabel(result.binding);
    rec.resolve(result);
  }

  onDown(input, e) {
    const mods = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
    if (this.recording) {
      this.recordDown(input, mods);
      return;
    }
    for (const [action, b] of Object.entries(this.bindings)) {
      if (!b || this.pressed.has(action) || !sameInput(b, input)) continue; // pressed — автоповтор клавиши
      if (!this.modifiersMatch(b, mods, action === 'pushToTalk')) continue;
      this.pressed.add(action);
      this.onAction(action, 'down');
    }
  }

  onUp(input) {
    if (this.recording) {
      // Модификатор нажали и отпустили без другой клавиши — назначаем сам модификатор (например, рация на Alt)
      if (input.key !== undefined && input.key === this.recording.modifier) this.finishRecord({ binding: { key: input.key } });
      return;
    }
    for (const action of [...this.pressed]) {
      const b = this.bindings[action];
      if (b && sameInput(b, input)) {
        this.pressed.delete(action);
        this.onAction(action, 'up');
      }
    }
  }

  /**
   * Переключатели срабатывают только на точное сочетание (Ctrl+M не вызывает действие на M).
   * Рация — на любое сочетание с нужными модификаторами: в игре вы можете держать Shift или Ctrl.
   * Если назначен сам модификатор, остальные не проверяются.
   */
  modifiersMatch(b, mods, lenient) {
    if (b.key !== undefined && MODIFIERS.has(b.key)) return true;
    return ['ctrl', 'shift', 'alt', 'meta'].every((m) => (lenient ? !b[m] || mods[m] : Boolean(b[m]) === Boolean(mods[m])));
  }

  recordDown(input, mods) {
    const rec = this.recording;
    if (input.mouse) {
      // Левая и правая кнопки нужны, чтобы пользоваться окном; назначать можно среднюю и боковые
      if (input.mouse >= 3) this.finishRecord({ binding: { mouse: input.mouse, ...mods } });
      return;
    }
    if (input.key === KEY.Escape) return this.finishRecord(null);
    if ((input.key === KEY.Backspace || input.key === KEY.Delete) && !mods.ctrl && !mods.alt) {
      return this.finishRecord({ cleared: true });
    }
    if (MODIFIERS.has(input.key)) {
      rec.modifier = input.key;
      return;
    }
    this.finishRecord({ binding: { key: input.key, ...mods } });
  }
}

module.exports = { Hotkeys, bindingLabel };
