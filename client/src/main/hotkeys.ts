/**
 * Глобальные горячие клавиши: работают, когда окно свёрнуто и в фокусе игра.
 *
 * Низкоуровневый хук клавиатуры и мыши (uiohook-napi) только наблюдает за нажатиями и не забирает
 * их у других программ — как в Discord. В отличие от globalShortcut Electron, видно и нажатие,
 * и отпускание (нужно для режима рации), и боковые кнопки мыши.
 *
 * Привязка: { key?: код uiohook, mouse?: 3–5, ctrl, shift, alt, meta, label }.
 */
import type { UiohookKeyboardEvent, UiohookMouseEvent } from 'uiohook-napi';
import type { Config, HotkeyAction, HotkeyBinding } from '../shared/config';
import type { HotkeyPhase, HotkeyRecordResult, HotkeysStatus } from '../shared/duo-api';

type Uiohook = typeof import('uiohook-napi');
type Modifiers = { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };
/** Нажатая клавиша или кнопка мыши */
type Input = { key: number; mouse?: undefined } | { mouse: number; key?: undefined };
/** Привязка без подписи — подпись добавляет finishRecord */
type RawBinding = Omit<HotkeyBinding, 'label' | 'ctrl' | 'shift' | 'alt' | 'meta'> & Partial<Modifiers>;

// Нативный модуль: если не загрузился (нет сборки под эту платформу), горячие клавиши просто недоступны
let uiohook: Uiohook | null = null;
let loadError = '';
try {
  uiohook = require('uiohook-napi') as Uiohook;
} catch (err) {
  loadError = (err as Error).message;
}

const KEY: Record<string, number> = uiohook?.UiohookKey ?? {};
const MODIFIERS = new Set([KEY.Ctrl, KEY.CtrlRight, KEY.Shift, KEY.ShiftRight, KEY.Alt, KEY.AltRight, KEY.Meta, KEY.MetaRight]);
const KEY_NAMES: Record<number, string> = Object.fromEntries(Object.entries(KEY).map(([name, code]) => [code, name]));
const PRETTY: Record<string, string> = {
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
const MOUSE_NAMES: Record<number, string> = { 3: 'Средняя кнопка мыши', 4: 'Мышь 4 (назад)', 5: 'Мышь 5 (вперёд)' };
const RECORD_TIMEOUT_MS = 15_000;

export function bindingLabel(b: RawBinding): string {
  if (b.mouse) return [...modifierNames(b), MOUSE_NAMES[b.mouse] ?? `Мышь ${b.mouse}`].join(' + ');
  const name = b.key !== undefined ? KEY_NAMES[b.key] : undefined;
  return [...modifierNames(b), (name && PRETTY[name]) ?? name?.replace(/^Numpad/, 'Num ') ?? `Клавиша ${b.key}`].join(' + ');
}

function modifierNames(b: Partial<Modifiers>): string[] {
  return [b.ctrl && 'Ctrl', b.shift && 'Shift', b.alt && 'Alt', b.meta && 'Win'].filter((x): x is string => Boolean(x));
}

const sameInput = (b: HotkeyBinding, input: Input) => (input.mouse ? b.mouse === input.mouse : b.key === input.key);

export class Hotkeys {
  private readonly onAction: (action: HotkeyAction, phase: HotkeyPhase) => void;
  private bindings: Partial<Config['hotkeys']> = {};
  private readonly pressed = new Set<HotkeyAction>();
  private recording: { resolve: (r: HotkeyRecordResult) => void; timer: NodeJS.Timeout; modifier: number | null } | null = null;
  private started = false;

  constructor(onAction: (action: HotkeyAction, phase: HotkeyPhase) => void) {
    this.onAction = onAction;
  }

  status(): HotkeysStatus {
    return { available: Boolean(uiohook), error: loadError };
  }

  /** Новые привязки из stream.config.json → hotkeys */
  update(bindings: Config['hotkeys']): void {
    this.bindings = { ...bindings };
    this.pressed.clear();
    if (Object.values(this.bindings).some(Boolean)) this.start();
  }

  start(): void {
    if (this.started || !uiohook) return;
    const { uIOhook } = uiohook;
    uIOhook.on('keydown', (e: UiohookKeyboardEvent) => this.onDown({ key: e.keycode }, e));
    uIOhook.on('keyup', (e: UiohookKeyboardEvent) => this.onUp({ key: e.keycode }));
    uIOhook.on('mousedown', (e: UiohookMouseEvent) => this.onDown({ mouse: Number(e.button) }, e));
    uIOhook.on('mouseup', (e: UiohookMouseEvent) => this.onUp({ mouse: Number(e.button) }));
    uIOhook.start();
    this.started = true;
  }

  stop(): void {
    if (this.started) uiohook?.uIOhook.stop();
    this.started = false;
  }

  /**
   * Ждёт следующее нажатие и возвращает привязку: {binding} — назначить, {cleared:true} — Backspace/Delete
   * (убрать), null — Esc или 15 с без нажатий.
   */
  record(): Promise<HotkeyRecordResult> {
    if (!uiohook) return Promise.reject(new Error(loadError || 'uiohook-napi не загружен'));
    this.cancelRecord();
    this.start();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishRecord(null), RECORD_TIMEOUT_MS);
      this.recording = { resolve, timer, modifier: null };
    });
  }

  cancelRecord(): void {
    this.finishRecord(null);
  }

  private finishRecord(result: { binding: RawBinding } | { cleared: true } | null): void {
    const rec = this.recording;
    if (!rec) return;
    this.recording = null;
    clearTimeout(rec.timer);
    if (result && 'binding' in result) {
      const b = result.binding;
      const binding: HotkeyBinding = { ...b, ctrl: Boolean(b.ctrl), shift: Boolean(b.shift), alt: Boolean(b.alt), meta: Boolean(b.meta), label: bindingLabel(b) };
      rec.resolve({ binding });
    } else {
      rec.resolve(result);
    }
  }

  private onDown(input: Input, e: Modifiers & { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean } | UiohookKeyboardEvent | UiohookMouseEvent): void {
    const mods: Modifiers = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
    if (this.recording) {
      this.recordDown(input, mods);
      return;
    }
    for (const [action, b] of Object.entries(this.bindings) as [HotkeyAction, HotkeyBinding | null][]) {
      if (!b || this.pressed.has(action) || !sameInput(b, input)) continue; // pressed — автоповтор клавиши
      if (!this.modifiersMatch(b, mods, action === 'pushToTalk')) continue;
      this.pressed.add(action);
      this.onAction(action, 'down');
    }
  }

  private onUp(input: Input): void {
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
  private modifiersMatch(b: HotkeyBinding, mods: Modifiers, lenient: boolean): boolean {
    if (b.key !== undefined && MODIFIERS.has(b.key)) return true;
    return (['ctrl', 'shift', 'alt', 'meta'] as const).every((m) => (lenient ? !b[m] || mods[m] : Boolean(b[m]) === Boolean(mods[m])));
  }

  private recordDown(input: Input, mods: Modifiers): void {
    const rec = this.recording!;
    if (input.mouse !== undefined) {
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
