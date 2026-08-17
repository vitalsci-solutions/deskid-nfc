/**
 * A ~40-line typed event emitter, so the package works identically in browsers,
 * Node and Bun without depending on `EventTarget` or `node:events`.
 *
 * @module
 */

/** A listener for an event whose payload is the tuple `A`. */
export type Listener<A extends unknown[]> = (...args: A) => unknown;

/** Map of event name → payload tuple. */
export type EventMap = Record<string, unknown[]>;

/**
 * Minimal emitter. A throwing (or rejecting) listener never breaks the emitter
 * or its caller: the failure is handed to `onListenerError` instead.
 */
export class Emitter<Events extends EventMap> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  constructor(private readonly onListenerError?: (error: Error, event: keyof Events) => void) {}

  /**
   * Subscribe to an event.
   *
   * @returns An unsubscribe function. Also removable with {@link off}.
   */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  /** Subscribe to an event, then unsubscribe after the first delivery. */
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, ((...args: Events[K]) => {
      off();
      return listener(...args);
    }) as Listener<Events[K]>);
    return off;
  }

  /** Unsubscribe a listener. Unknown listeners are ignored. */
  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  /** Remove every listener, or every listener for one event. */
  removeAll(event?: keyof Events): void {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }

  /** Deliver an event to its listeners, in subscription order. */
  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        const result = (listener as Listener<Events[K]>)(...args);
        // Async listeners are common (`nfc.on('tag', async () => nfc.read())`),
        // so their rejections must not become unhandled promise rejections.
        if (result instanceof Promise) {
          result.catch((error: unknown) => this.reportListenerError(error, event));
        }
      } catch (error) {
        this.reportListenerError(error, event);
      }
    }
  }

  private reportListenerError(error: unknown, event: keyof Events): void {
    this.onListenerError?.(error instanceof Error ? error : new Error(String(error)), event);
  }
}
