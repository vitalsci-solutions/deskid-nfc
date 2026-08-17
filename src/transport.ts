/**
 * WebSerial transport for Metratec AT-protocol readers.
 *
 * Owns the byte stream and the command/response framing, and knows nothing
 * about NFC. The framing rules encoded here were all observed on real hardware
 * (DeskID NFC, firmware 2.08):
 *
 * - TX is `<command>\r` — CR only, never CRLF.
 * - RX lines are usually `\r\n`-terminated, but bare `\r` occurs (continuous
 *   inventory events), so split on either and collapse runs of delimiters.
 * - The device emits runs of NUL bytes as padding; they are stripped before
 *   parsing, otherwise `"\0\0OK" !== "OK"` breaks line matching.
 * - A read can end mid-line, so bytes are buffered across reads.
 * - A response block is zero or more `+TAG: data` lines terminated by `OK` or
 *   `ERROR`; on `ERROR` the cause is the last `<...>` group before it.
 * - `+CINV:` lines are *unsolicited events* and may interleave with an
 *   unrelated command's response, so they are routed separately.
 * - Only one command is ever in flight; concurrent commands corrupt response
 *   attribution, so they queue behind a mutex.
 *
 * @module
 */
import { ReaderError } from './errors.js';

/** Direction/kind of a {@link LogEntry}. */
export type LogDirection = 'tx' | 'rx' | 'info' | 'error';

/** One line of protocol traffic or lifecycle information. */
export interface LogEntry {
  /** `Date.now()` when the entry was produced. */
  at: number;
  direction: LogDirection;
  /** The line, without terminators. */
  text: string;
}

/** USB identifiers of a port, as reported by WebSerial. */
export interface SerialPortInfoLike {
  usbVendorId?: number;
  usbProductId?: number;
}

/**
 * The subset of the WebSerial `SerialPort` interface this package uses.
 *
 * Declared structurally so the package needs no DOM lib types, and so a fake
 * port can be injected in tests (see {@link DeskIdNfc.open}).
 */
export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo?(): SerialPortInfoLike;
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
}

/** Tuning knobs for {@link SerialTransport}. */
export interface TransportOptions {
  /** Serial baud rate. The DeskID NFC runs at 115200; don't change it. @default 115200 */
  baudRate?: number;
  /** Default per-command response timeout in ms. @default 2000 */
  commandTimeoutMs?: number;
  /**
   * Delay between opening the port and the first probe. A CDC device can stay
   * silent for a moment after `open()`. @default 200
   */
  settleMs?: number;
  /** How many times `AT` is retried while probing for life. @default 3 */
  probeAttempts?: number;
  /** Called for every TX/RX line and lifecycle note. Cheap and very useful — wire it up. */
  onLog?: (entry: LogEntry) => void;
  /**
   * Called for each unsolicited `+CINV:` payload (idle round markers filtered
   * out), i.e. `UID` or `UID,SAK,ATQA` when tag details are enabled.
   */
  onInventoryEvent?: (value: string) => void;
  /** Called when the port disappears on its own (unplug, crash, driver reset). */
  onLost?: (error: Error) => void;
}

interface PendingCommand {
  cmd: string;
  lines: string[];
  timer: ReturnType<typeof setTimeout>;
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
}

const CINV_PREFIX = '+CINV:';
/** Round markers arrive ~50×/s while continuous inventory runs — never surfaced. */
const IDLE_MARKERS = new Set(['<ROUND FINISHED>', '<NO TAGS FOUND>']);

/** Whether this runtime exposes the WebSerial API. */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Show the browser's port picker and return the chosen port.
 *
 * Pass no filters (the default): the DeskID NFC is built on an RP2040 and
 * therefore reports the *Raspberry Pi* USB vendor id `0x2e8a`, which any RP2040
 * device shares — it is not a usable identity filter. Identify the reader after
 * connecting, via `ATI` ({@link DeskIdNfc.info}).
 *
 * Must be called from a user gesture (click), like all WebSerial permission prompts.
 *
 * @throws {ReaderError} with code `unsupported` outside a WebSerial-capable browser.
 */
export async function requestSerialPort(filters?: SerialPortInfoLike[]): Promise<SerialPortLike> {
  if (!isWebSerialSupported()) {
    throw new ReaderError(
      'WebSerial is not available. Use a Chromium-based browser over HTTPS (or localhost).',
      'unsupported',
    );
  }
  const serial = (navigator as unknown as { serial: { requestPort(o?: unknown): Promise<SerialPortLike> } }).serial;
  return serial.requestPort(filters ? { filters } : undefined);
}

/**
 * Line-framed AT command transport over a WebSerial port.
 *
 * Usually you don't construct this yourself — {@link DeskIdNfc} owns one. Use
 * it directly only to talk to another Metratec AT reader, or to script commands
 * this package doesn't model.
 */
export class SerialTransport {
  private readonly options: Required<Pick<TransportOptions, 'baudRate' | 'commandTimeoutMs' | 'settleMs' | 'probeAttempts'>> &
    TransportOptions;

  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopDone: Promise<void> = Promise.resolve();
  private buffer = '';
  private pending: PendingCommand | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private readonly encoder = new TextEncoder();

  constructor(options: TransportOptions = {}) {
    this.options = {
      baudRate: 115200,
      commandTimeoutMs: 2000,
      settleMs: 200,
      probeAttempts: 3,
      ...options,
    };
  }

  /** True between a successful {@link open} and the port going away. */
  get isOpen(): boolean {
    return this.port !== null;
  }

  /** USB ids of the open port, when the platform reports them. */
  get portInfo(): SerialPortInfoLike | undefined {
    return this.port?.getInfo?.();
  }

  /**
   * Open the port, assert DTR/RTS, and probe with `AT` until the reader answers `OK`.
   *
   * The probe makes connecting deterministic: without it, the first real command
   * is the one that mysteriously times out. If the port was left open by a
   * previous session (a hot reload, a crashed tab), it is closed and reopened once.
   *
   * @throws {ReaderError} if the reader never answers the probe. The port is closed again in that case.
   */
  async open(port: SerialPortLike): Promise<void> {
    if (this.port) throw new ReaderError('Transport is already open', 'device');
    const info = port.getInfo?.();
    if (info) {
      this.log('info', `port selected (usbVendorId=0x${info.usbVendorId?.toString(16)}, usbProductId=0x${info.usbProductId?.toString(16)})`);
    }
    try {
      await port.open({ baudRate: this.options.baudRate });
    } catch (error) {
      if (!/already open/i.test((error as Error).message)) throw error;
      // A stale instance still holds the granted port — reclaim it instead of failing.
      this.log('info', 'port was left open by a previous session — reopening');
      await port.close().catch(() => {});
      await port.open({ baudRate: this.options.baudRate });
    }
    this.log('info', `port opened @${this.options.baudRate}`);

    this.closing = false;
    this.port = port;
    this.buffer = '';
    this.writer = port.writable!.getWriter();
    this.addDisconnectListener();
    this.readLoopDone = this.readLoop(port);

    try {
      try {
        await port.setSignals?.({ dataTerminalReady: true, requestToSend: true });
        this.log('info', 'DTR/RTS asserted');
      } catch (error) {
        // Not supported on every platform — the probe decides whether it mattered.
        this.log('info', `setSignals failed: ${(error as Error).message}`);
      }
      await this.probe();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * Release the port cleanly.
   *
   * Order matters: `port.close()` throws while the read loop still holds the
   * readable's lock, and a swallowed failure there leaves the port open — the
   * next connect then dies with *"The port is already open"*. So the reader is
   * cancelled, the loop is awaited, the writer lock released, and only then is
   * the port closed.
   */
  async close(): Promise<void> {
    if (!this.port) return;
    this.closing = true;
    this.removeDisconnectListener();
    try {
      await this.reader?.cancel();
    } catch {
      // the port may already be gone
    }
    await this.readLoopDone;
    try {
      this.writer?.releaseLock();
    } catch {
      // already released
    }
    const port = this.port;
    this.port = null;
    this.writer = null;
    this.reader = null;
    try {
      await port.close();
      this.log('info', 'port closed');
    } catch (error) {
      this.log('error', `port close failed: ${(error as Error).message}`);
    }
    this.failPending(new ReaderError('Port closed', 'disconnected'));
    this.closing = false;
  }

  /**
   * Send an AT command and wait for its terminating `OK` / `ERROR`.
   *
   * Commands are serialized: calling this while another command is in flight
   * queues behind it rather than interleaving.
   *
   * @param cmd The command without its terminator, e.g. `AT+SEL=901974A2429B04`.
   * @param timeoutMs Overrides {@link TransportOptions.commandTimeoutMs}.
   * @returns The `+TAG: data` lines received before `OK` (often empty).
   * @throws {ReaderError} code `device` (message is the reader's `<cause>`),
   *   `timeout`, `not-connected`, or `disconnected`.
   *
   * @example
   * ```ts
   * const [line] = await transport.command('AT+CHKNDEF'); // '+CHKNDEF: RW'
   * ```
   */
  command(cmd: string, timeoutMs = this.options.commandTimeoutMs): Promise<string[]> {
    const result = this.queue.then(() => this.execute(cmd, timeoutMs));
    // Keep the chain alive regardless of outcome, so one failure doesn't wedge the queue.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private execute(cmd: string, timeoutMs: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const writer = this.writer;
      if (!writer) {
        reject(new ReaderError('Not connected', 'not-connected', cmd));
        return;
      }
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new ReaderError(`Timeout waiting for a response to ${cmd}`, 'timeout', cmd));
      }, timeoutMs);
      // Registered before the write so a synchronous reply can't be missed.
      this.pending = { cmd, lines: [], timer, resolve, reject };
      this.log('tx', cmd);
      writer.write(this.encoder.encode(`${cmd}\r`)).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending = null;
        reject(new ReaderError(`Write failed: ${(error as Error).message}`, 'disconnected', cmd));
      });
    });
  }

  /** Retry `AT` a few times so a slow post-open reader doesn't fail the whole connect. */
  private async probe(): Promise<void> {
    await delay(this.options.settleMs);
    let last: Error | undefined;
    for (let attempt = 0; attempt < this.options.probeAttempts; attempt++) {
      try {
        await this.command('AT', Math.min(750, this.options.commandTimeoutMs));
        this.log('info', 'AT probe answered');
        return;
      } catch (error) {
        last = error as Error;
      }
    }
    throw new ReaderError(`Reader is not responding to the AT probe: ${last?.message}`, 'timeout', 'AT');
  }

  private async readLoop(port: SerialPortLike): Promise<void> {
    const decoder = new TextDecoder();
    const reader = port.readable!.getReader();
    this.reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.handleChunk(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      this.log('error', `read loop error: ${(error as Error).message}`);
    } finally {
      reader.releaseLock();
      this.handlePortGone(new ReaderError('Device disconnected', 'disconnected'));
    }
  }

  private handleChunk(chunk: string): void {
    // NUL padding bytes would corrupt line matching, so drop them before buffering.
    this.buffer += chunk.replaceAll('\0', '');
    let delimiter = this.buffer.search(/[\r\n]/);
    while (delimiter !== -1) {
      const line = this.buffer.slice(0, delimiter);
      let next = delimiter + 1;
      while (next < this.buffer.length && /[\r\n]/.test(this.buffer[next])) next++;
      this.buffer = this.buffer.slice(next);
      if (line.length > 0) this.handleLine(line);
      delimiter = this.buffer.search(/[\r\n]/);
    }
  }

  private handleLine(line: string): void {
    if (line.startsWith(CINV_PREFIX)) {
      const value = line.slice(CINV_PREFIX.length).trim();
      if (!IDLE_MARKERS.has(value)) {
        this.log('rx', line);
        this.options.onInventoryEvent?.(value);
      }
      return;
    }

    this.log('rx', line);
    const pending = this.pending;
    if (!pending) return; // unsolicited and not an inventory event — logging is all we can do

    if (line === 'OK') {
      clearTimeout(pending.timer);
      this.pending = null;
      pending.resolve(pending.lines);
      return;
    }

    if (line === 'ERROR') {
      clearTimeout(pending.timer);
      this.pending = null;
      // The machine-readable cause sits in <...> on the line before ERROR.
      const cause = /<([^>]*)>/.exec(pending.lines[pending.lines.length - 1] ?? '');
      pending.reject(new ReaderError(cause ? cause[1] : `${pending.cmd} failed`, 'device', pending.cmd));
      return;
    }

    pending.lines.push(line);
  }

  private handleDisconnectEvent = (event: Event): void => {
    if ('port' in event && (event as { port?: unknown }).port !== this.port) return;
    this.handlePortGone(new ReaderError('Device disconnected', 'disconnected'));
  };

  private handlePortGone(error: ReaderError): void {
    // An intentional close() owns the teardown — don't pull state out from under it.
    if (this.closing || !this.port) return;
    this.removeDisconnectListener();
    this.port = null;
    this.writer = null;
    this.reader = null;
    this.failPending(error);
    this.log('error', error.message);
    this.options.onLost?.(error);
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(error);
  }

  private addDisconnectListener(): void {
    if (!isWebSerialSupported()) return;
    (navigator as unknown as { serial: EventTarget }).serial.addEventListener('disconnect', this.handleDisconnectEvent);
  }

  private removeDisconnectListener(): void {
    if (!isWebSerialSupported()) return;
    (navigator as unknown as { serial: EventTarget }).serial.removeEventListener('disconnect', this.handleDisconnectEvent);
  }

  private log(direction: LogDirection, text: string): void {
    this.options.onLog?.({ at: Date.now(), direction, text });
  }
}

/** `await delay(50)` — used for the RF field power-cycle timings. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
