// Типизированные события поверх EventTarget: карта «имя события → данные (detail)».

export class Emitter<E extends object> extends EventTarget {
  emit<K extends keyof E & string>(type: K, detail: E[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Подписка на событие; возвращает функцию отписки */
  on<K extends keyof E & string>(type: K, fn: (detail: E[K]) => void, options?: AddEventListenerOptions): () => void {
    const handler = (e: Event) => fn((e as CustomEvent<E[K]>).detail);
    this.addEventListener(type, handler, options);
    return () => this.removeEventListener(type, handler);
  }
}
