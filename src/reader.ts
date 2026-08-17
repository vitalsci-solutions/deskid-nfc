/**
 * High-level driver for the Metratec DeskID NFC desk reader over WebSerial.
 *
 * This class owns the four hardware quirks that cause most of the pain when
 * talking to this reader directly (all observed on firmware 2.08):
 *
 * 1. **The RF field idles off**, so a cold single-shot `AT+INV` often misses a
 *    tag that is sitting on the antenna. The field is switched on at connect
 *    (`AT+CW=1`) and off again at {@link DeskIdNfc.close}.
 * 2. **Tags park in ISO14443 HALT state** after a completed select/deselect
 *    cycle, and this firmware's `AT+SEL` cannot address a halted tag — every
 *    second select fails with `<Tag timeout>`. On that error the field is
 *    power-cycled (which resets the tag to IDLE) and the select is retried once.
 * 3. **Continuous inventory keeps running inside the reader** after the port
 *    closes or the page reloads, and its rounds collide with `AT+SEL`. It is
 *    therefore stopped explicitly at connect, before anything else.
 * 4. **Continuous inventory floods the link** with ~50 idle round markers per
 *    second. They are filtered inside the transport, so only real UID sightings
 *    reach your code.
 *
 * @module
 */
import { Emitter, type Listener } from './emitter.js';
import { ReaderError, isTagRemovedError } from './errors.js';
import { decodeNdefMessage, encodeNdefMessage, type NdefRecord } from './ndef.js';
import {
  SerialTransport,
  delay,
  isWebSerialSupported,
  requestSerialPort,
  type LogEntry,
  type SerialPortInfoLike,
  type SerialPortLike,
} from './transport.js';

/** Identity of the connected reader, from `ATI`. */
export interface ReaderInfo {
  /** Firmware, e.g. `DeskID_NFC 0208` (= version 2.08). */
  firmware: string;
  /** Hardware revision, e.g. `DeskID_NFC 0103`. */
  hardware: string;
  /** Device serial number, e.g. `2024022112041465`. */
  serial: string;
}

/** A tag seen by the reader. */
export interface Tag {
  /**
   * UID in the reader's byte order — pass this back to the library as-is.
   * Use {@link reverseUid} to get the order phones and NXP tools display.
   */
  uid: string;
  /** Select acknowledge byte, when tag details are enabled (they are, by default). */
  sak?: string;
  /** Answer to request, type A. */
  atqa?: string;
  /** `Date.now()` of the first inventory round that saw this tag. */
  firstSeen: number;
  /** `Date.now()` of the most recent inventory round that saw this tag. */
  lastSeen: number;
}

/**
 * NDEF status of a tag, from `AT+CHKNDEF`.
 *
 * - `RW` — formatted and writable.
 * - `RO` — formatted but write-protected.
 * - `NO NDEF` — no NDEF structure yet; {@link DeskIdNfc.format} it first (writes do this automatically).
 * - `INITIALIZED` — formatted but empty.
 * - `MISCONFIGURED` — the NDEF structure is inconsistent; reformat.
 */
export type NdefState = 'NO NDEF' | 'INITIALIZED' | 'RO' | 'RW' | 'MISCONFIGURED';

/** Result of reading a tag's NDEF message. */
export interface NdefReadResult {
  /** The tag that was read. */
  uid: string;
  state: NdefState;
  /** The raw NDEF message as returned by the reader (hex). Empty when the tag has no message. */
  hex: string;
  /** The decoded records. Empty when the tag has no message. */
  records: NdefRecord[];
}

/** Why the connection ended. */
export type CloseReason = 'requested' | 'lost';

/** Events emitted by {@link DeskIdNfc}. Subscribe with {@link DeskIdNfc.on}. */
export interface DeskIdNfcEvents extends Record<string, unknown[]> {
  /** A tag was placed on the reader (or swapped for a different one). */
  tag: [tag: Tag];
  /** The tag left the field, or an operation proved it was gone. */
  tagleft: [tag: Tag];
  /** Every TX/RX line and lifecycle note. Wire this to your logger. */
  log: [entry: LogEntry];
  /** A background failure: the watch loop, or a throwing event listener. */
  error: [error: Error];
  /** The connection ended, either via {@link DeskIdNfc.close} or by unplugging. */
  close: [reason: CloseReason];
}

/** Options for {@link DeskIdNfc}. All have sensible defaults. */
export interface DeskIdNfcOptions {
  /**
   * Tag family to poll for: `ISO14A` for NTAG / MIFARE (proximity), `ISO15` for
   * ISO15693 vicinity tags. @default 'ISO14A'
   */
  mode?: 'ISO14A' | 'ISO15';
  /**
   * Start continuous inventory (and therefore `tag` / `tagleft` events) as soon
   * as {@link DeskIdNfc.open} succeeds. @default true
   */
  watch?: boolean;
  /**
   * A tag counts as gone once no inventory round has seen it for this long.
   * @default 1500
   */
  presenceTimeoutMs?: number;
  /** How often presence is re-evaluated, in ms. @default 300 */
  presencePollMs?: number;
  /** Buzz the reader on write success/failure (`AT+FDB`). @default true */
  beepOnWrite?: boolean;
  /** Serial baud rate. The DeskID NFC runs at 115200; don't change it. @default 115200 */
  baudRate?: number;
  /** Default per-command response timeout in ms. @default 2000 */
  commandTimeoutMs?: number;
  /** Timeout for slow NDEF commands (read/write/format), in ms. @default 5000 */
  ndefTimeoutMs?: number;
  /** Delay between opening the port and the first `AT` probe, in ms. @default 200 */
  settleMs?: number;
  /** Convenience alternative to `on('log', ...)`, so nothing is missed during `open()`. */
  onLog?: (entry: LogEntry) => void;
}

type ResolvedOptions = Required<Omit<DeskIdNfcOptions, 'onLog'>> & Pick<DeskIdNfcOptions, 'onLog'>;

const DEFAULTS: ResolvedOptions = {
  mode: 'ISO14A',
  watch: true,
  presenceTimeoutMs: 1500,
  presencePollMs: 300,
  beepOnWrite: true,
  baudRate: 115200,
  commandTimeoutMs: 2000,
  ndefTimeoutMs: 5000,
  settleMs: 200,
};

/** Strip a `+TAG:` prefix and surrounding whitespace from a response line. */
function stripPrefix(line: string, prefix: string): string {
  return (line.startsWith(prefix) ? line.slice(prefix.length) : line).trim();
}

/**
 * A connected (or connectable) DeskID NFC reader.
 *
 * The model is event-driven: continuous inventory runs the whole time the port
 * is open, `tag` fires when something lands on the reader, and read/write calls
 * transparently pause and resume that loop.
 *
 * @example
 * ```ts
 * const nfc = new DeskIdNfc();
 *
 * nfc.on('tag', async (tag) => {
 *   const { records } = await nfc.read(tag.uid);
 *   console.log(tag.uid, records);
 * });
 * nfc.on('tagleft', () => console.log('tag removed'));
 *
 * // must be called from a user gesture: WebSerial shows a port picker
 * button.onclick = () => nfc.open();
 * ```
 */
export class DeskIdNfc {
  private readonly options: ResolvedOptions;
  private readonly emitter = new Emitter<DeskIdNfcEvents>((error) => this.emitter.emit('error', error));
  private readonly transport: SerialTransport;

  private tag: Tag | null = null;
  private readerInfo: ReaderInfo | null = null;
  private watching = false;
  private watchPaused = false;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  /** Serializes RF operations: concurrent select-based work fails in confusing ways. */
  private rfQueue: Promise<unknown> = Promise.resolve();

  constructor(options: DeskIdNfcOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.transport = new SerialTransport({
      baudRate: this.options.baudRate,
      commandTimeoutMs: this.options.commandTimeoutMs,
      settleMs: this.options.settleMs,
      onLog: (entry) => {
        this.options.onLog?.(entry);
        this.emitter.emit('log', entry);
      },
      onInventoryEvent: (value) => this.handleInventoryEvent(value),
      onLost: () => this.handleLost(),
    });
  }

  /** Whether this runtime can talk to serial devices at all. */
  static isSupported(): boolean {
    return isWebSerialSupported();
  }

  /** True between a successful {@link open} and {@link close} (or an unplug). */
  get isOpen(): boolean {
    return this.transport.isOpen;
  }

  /** Identity of the connected reader, or `null` while closed. */
  get info(): ReaderInfo | null {
    return this.readerInfo;
  }

  /** USB ids of the open port, when the platform reports them. */
  get portInfo(): SerialPortInfoLike | undefined {
    return this.transport.portInfo;
  }

  /**
   * The tag currently on the reader, or `null`.
   *
   * Freshness is maintained by the watch loop; the value is cleared once
   * {@link DeskIdNfcOptions.presenceTimeoutMs} passes without a sighting.
   */
  get currentTag(): Tag | null {
    return this.tag;
  }

  /** Whether continuous inventory is running (it is paused during read/write). */
  get isWatching(): boolean {
    return this.watching && !this.watchPaused;
  }

  /**
   * Subscribe to an event.
   *
   * @returns An unsubscribe function.
   * @see {@link DeskIdNfcEvents}
   */
  on<K extends keyof DeskIdNfcEvents>(event: K, listener: Listener<DeskIdNfcEvents[K]>): () => void {
    return this.emitter.on(event, listener);
  }

  /** Unsubscribe a listener registered with {@link on}. */
  off<K extends keyof DeskIdNfcEvents>(event: K, listener: Listener<DeskIdNfcEvents[K]>): void {
    this.emitter.off(event, listener);
  }

  /**
   * Open a port, initialize the reader, and (unless `watch: false`) start
   * watching for tags.
   *
   * @param port A port to use. Omit it to show the browser's port picker —
   *   which requires being inside a user gesture. Pass one explicitly to reuse
   *   an already-granted port (`navigator.serial.getPorts()`), or to inject a
   *   fake in tests.
   * @returns The reader's identity, also available as {@link info}.
   * @throws {ReaderError} `unsupported` without WebSerial, `timeout` if the
   *   reader never answers the `AT` probe. The port is closed again on failure.
   *
   * @example
   * ```ts
   * // reconnect silently to a port the user already approved
   * const [known] = await navigator.serial.getPorts();
   * await nfc.open(known);
   * ```
   */
  async open(port?: SerialPortLike): Promise<ReaderInfo> {
    if (this.isOpen) throw new ReaderError('Reader is already open', 'device');
    const target = port ?? (await requestSerialPort());
    await this.transport.open(target);
    try {
      await this.initialize();
      this.readerInfo = await this.readInfo();
    } catch (error) {
      await this.transport.close().catch(() => {});
      throw error;
    }
    this.startPresenceTimer();
    if (this.options.watch) await this.startWatch();
    return this.readerInfo;
  }

  /**
   * Stop watching, switch the RF field off, and release the port.
   *
   * Always call this before leaving the page (and from your dev server's
   * hot-reload dispose hook): the reader keeps a continuous inventory running in
   * its own firmware after the port closes, and the field keeps radiating.
   * Safe to call when already closed.
   */
  async close(): Promise<void> {
    if (!this.isOpen) return;
    this.stopPresenceTimer();
    await this.stopWatch().catch(() => {});
    await this.transport.command('AT+CW=0', 500).catch(() => {});
    await this.transport.close();
    this.watching = false;
    this.watchPaused = false;
    this.readerInfo = null;
    this.forgetTag();
    this.emitter.emit('close', 'requested');
  }

  /**
   * Start continuous inventory, i.e. `tag` / `tagleft` events.
   *
   * Called automatically by {@link open} unless {@link DeskIdNfcOptions.watch}
   * is `false`. Idempotent.
   */
  async startWatch(): Promise<void> {
    this.watching = true;
    this.watchPaused = false;
    await this.transport.command('AT+CINV');
  }

  /**
   * Stop continuous inventory. Idempotent — "not running" is treated as success,
   * which is what the reader answers when no scan is active.
   */
  async stopWatch(): Promise<void> {
    this.watching = false;
    try {
      await this.transport.command('AT+BINV', 1000);
    } catch (error) {
      if (!/is not running/i.test((error as Error).message)) throw error;
    }
  }

  /**
   * Run a single inventory round and return what is on the antenna right now.
   *
   * Prefer the `tag` event: single-shot inventory is one brief RF round and can
   * miss a tag that continuous inventory finds immediately. Useful for a
   * one-off "is anything there?" check.
   */
  async inventory(): Promise<Tag[]> {
    return this.exclusive(async () => {
      const lines = await this.transport.command('AT+INV');
      const now = Date.now();
      const tags: Tag[] = [];
      for (const line of lines) {
        const value = stripPrefix(line, '+INV:');
        if (value.startsWith('<')) continue; // <NO TAGS FOUND> — emptiness is data, not an error
        const [uid, sak, atqa] = value.split(',');
        tags.push({ uid, sak, atqa, firstSeen: now, lastSeen: now });
      }
      return tags;
    });
  }

  /**
   * Read a tag's NDEF status without reading its content.
   *
   * @param uid Defaults to {@link currentTag}.
   * @throws {ReaderError} `no-tag` when nothing is on the reader.
   */
  async checkNdef(uid?: string): Promise<NdefState> {
    return this.withSelectedTag(uid, () => this.readNdefState());
  }

  /**
   * Read and decode a tag's NDEF message.
   *
   * @param uid Defaults to {@link currentTag}.
   * @returns The NDEF state plus decoded records. A tag with no NDEF structure
   *   returns state `NO NDEF` and no records rather than throwing.
   * @throws {ReaderError} `no-tag` when nothing is on the reader, or `device`
   *   with the reader's own message (e.g. `Tag timeout` when the tag was moved
   *   away — check with {@link isTagRemovedError}).
   *
   * @example
   * ```ts
   * const { state, records } = await nfc.read();
   * for (const record of records) console.log(ndefRecordToString(record));
   * ```
   */
  async read(uid?: string): Promise<NdefReadResult> {
    const target = this.requireUid(uid);
    return this.withSelectedTag(target, async () => {
      const state = await this.readNdefState();
      if (state === 'NO NDEF') return { uid: target, state, hex: '', records: [] };
      const lines = await this.transport.command('AT+RDNDEF', this.options.ndefTimeoutMs);
      const hex = lines.map((line) => stripPrefix(line, '+RDNDEF:')).join('');
      if (hex.length === 0) return { uid: target, state, hex, records: [] };
      try {
        return { uid: target, state, hex, records: decodeNdefMessage(hex) };
      } catch (error) {
        throw new ReaderError(
          `Could not decode the NDEF message on ${target}: ${(error as Error).message} (hex: ${hex})`,
          'device',
          'AT+RDNDEF',
        );
      }
    });
  }

  /**
   * Write records to a tag, formatting it first if needed.
   *
   * @param records One record or a list of them; see {@link NdefRecord}.
   * @param options.uid Target tag. Defaults to {@link currentTag}.
   * @param options.verify Read the tag back afterwards and return the result. @default true
   * @returns The verification read, or `null` when `verify` is `false`.
   * @throws {ReaderError} `no-tag`, or `device` with the reader's message. On a
   *   {@link isTagRemovedError} failure the tag content may be partially written.
   *
   * @example
   * ```ts
   * await nfc.write({ kind: 'uri', uri: 'https://example.com' });
   * await nfc.write([
   *   { kind: 'text', lang: 'en', text: 'Meeting room 3' },
   *   { kind: 'uri', uri: 'https://intranet/room/3' },
   * ]);
   * ```
   */
  async write(
    records: NdefRecord | readonly NdefRecord[],
    options: { uid?: string; verify?: boolean } = {},
  ): Promise<NdefReadResult | null> {
    const list = Array.isArray(records) ? records : [records as NdefRecord];
    return this.writeHex(encodeNdefMessage(list), options);
  }

  /**
   * Write a pre-encoded NDEF message (hex) to a tag.
   *
   * Escape hatch for record types {@link encodeNdefMessage} doesn't build.
   * Otherwise identical to {@link write}.
   */
  async writeHex(hex: string, options: { uid?: string; verify?: boolean } = {}): Promise<NdefReadResult | null> {
    const target = this.requireUid(options.uid);
    await this.withSelectedTag(target, async () => {
      const state = await this.readNdefState();
      if (state === 'RO') {
        throw new ReaderError(`Tag ${target} is write-protected (NDEF state RO)`, 'device', 'AT+WRTNDEF');
      }
      if (state === 'NO NDEF' || state === 'MISCONFIGURED') {
        await this.transport.command('AT+FMTNDEF', this.options.ndefTimeoutMs);
      }
      try {
        await this.transport.command(`AT+WRTNDEF=${hex}`, this.options.ndefTimeoutMs);
      } catch (error) {
        if (this.options.beepOnWrite) await this.beep('error').catch(() => {});
        throw error;
      }
      if (this.options.beepOnWrite) await this.beep('ok').catch(() => {});
    });
    // Verification re-selects the tag deliberately: that path exercises the
    // HALT-state wake-up, and is the sequence verified against real hardware.
    return options.verify === false ? null : this.read(target);
  }

  /**
   * Write an empty NDEF structure to a tag, erasing its content.
   *
   * @param uid Defaults to {@link currentTag}.
   */
  async format(uid?: string): Promise<void> {
    await this.withSelectedTag(uid, async () => {
      await this.transport.command('AT+FMTNDEF', this.options.ndefTimeoutMs);
    });
  }

  /**
   * Sound the reader's buzzer: a rising "ok" or a falling "error" tone (`AT+FDB`).
   * Writes do this for you unless {@link DeskIdNfcOptions.beepOnWrite} is off.
   */
  async beep(kind: 'ok' | 'error' = 'ok'): Promise<void> {
    await this.transport.command(`AT+FDB=${kind === 'ok' ? 1 : 2}`);
  }

  /**
   * Send a raw AT command, serialized against this package's own traffic.
   *
   * Use for anything not modelled here (`AT+HOT`, `AT+DTT`, `AT+PWD`, …); see
   * Metratec's AT command reference. Does *not* pause the watch loop — call
   * {@link stopWatch} first for anything select-based.
   *
   * @returns The `+TAG: data` lines before `OK`.
   *
   * @example
   * ```ts
   * const [line] = await nfc.command('AT+CW?'); // '+CW: 1'
   * ```
   */
  async command(cmd: string, timeoutMs?: number): Promise<string[]> {
    return this.transport.command(cmd, timeoutMs);
  }

  // --- internals -----------------------------------------------------------

  /** Connect-time setup, in the order that proved reliable on hardware. */
  private async initialize(): Promise<void> {
    // A continuous inventory started by a previous session is still running
    // inside the reader — its rounds collide with AT+SEL, so clear it first.
    await this.transport.command('AT+BINV', 1000).catch(() => {});
    await this.transport.command(`AT+MOD=${this.options.mode}`);
    await this.transport.command('AT+INVS=1,0,0'); // report UID,SAK,ATQA
    // Keep the field energized for the whole session: it idles off otherwise,
    // and small tag antennas don't power up in time for a single cold round.
    await this.transport.command('AT+CW=1');
  }

  private async readInfo(): Promise<ReaderInfo> {
    const lines = await this.transport.command('ATI');
    const info: ReaderInfo = { firmware: '', hardware: '', serial: '' };
    for (const line of lines) {
      // ATI separates label and value with a run of spaces, not a single one.
      if (line.startsWith('+SW:')) info.firmware = stripPrefix(line, '+SW:').replace(/\s+/g, ' ');
      else if (line.startsWith('+HW:')) info.hardware = stripPrefix(line, '+HW:').replace(/\s+/g, ' ');
      else if (line.startsWith('+SERIAL:')) info.serial = stripPrefix(line, '+SERIAL:');
    }
    return info;
  }

  private handleInventoryEvent(value: string): void {
    // With tag details enabled the payload is `UID,SAK,ATQA`. The suffix must be
    // stripped before the UID is used in AT+SEL, or the reader answers ERROR.
    const [uid, sak, atqa] = value.split(',');
    if (!uid) return;
    const now = Date.now();
    const previous = this.tag;
    if (previous && previous.uid === uid) {
      previous.lastSeen = now;
      return;
    }
    if (previous) this.forgetTag();
    this.tag = { uid, sak, atqa, firstSeen: now, lastSeen: now };
    this.emitter.emit('tag', this.tag);
  }

  private startPresenceTimer(): void {
    this.stopPresenceTimer();
    this.presenceTimer = setInterval(() => {
      // While the watch is paused nobody is refreshing `lastSeen`, so expiry
      // would fire spuriously mid-operation. RF errors report removal instead.
      if (!this.tag || this.watchPaused || !this.watching) return;
      if (Date.now() - this.tag.lastSeen >= this.options.presenceTimeoutMs) this.forgetTag();
    }, this.options.presencePollMs);
    // Don't hold a Node/Bun process open just for presence polling.
    (this.presenceTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopPresenceTimer(): void {
    if (this.presenceTimer !== null) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  private forgetTag(): void {
    const gone = this.tag;
    this.tag = null;
    if (gone) this.emitter.emit('tagleft', gone);
  }

  private handleLost(): void {
    this.stopPresenceTimer();
    this.watching = false;
    this.watchPaused = false;
    this.readerInfo = null;
    this.forgetTag();
    this.emitter.emit('close', 'lost');
  }

  private requireUid(uid?: string): string {
    const target = uid ?? this.tag?.uid;
    if (!target) throw new ReaderError('No tag on the reader', 'no-tag');
    return target;
  }

  /**
   * Run an RF operation with the watch loop paused, serialized against all other
   * RF operations. Every select-based command must go through here: continuous
   * inventory rounds collide with `AT+SEL`.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.rfQueue.then(async () => {
      const resume = this.watching;
      if (resume) {
        this.watchPaused = true;
        await this.stopWatch().catch(() => {});
      }
      try {
        return await fn();
      } catch (error) {
        // A tag that left mid-operation is gone as far as presence is concerned;
        // the watch loop can't tell us, because it was paused.
        if (isTagRemovedError(error)) this.forgetTag();
        throw error;
      } finally {
        if (resume) {
          this.watchPaused = false;
          await this.startWatch().catch((error: unknown) => {
            this.emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
          });
        }
      }
    });
    this.rfQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** {@link exclusive} plus select/deselect around the tag. */
  private withSelectedTag<T>(uid: string | undefined, fn: (uid: string) => Promise<T>): Promise<T> {
    const target = this.requireUid(uid);
    return this.exclusive(async () => {
      await this.select(target);
      try {
        return await fn(target);
      } finally {
        await this.transport.command('AT+DEL').catch(() => {});
      }
    });
  }

  /**
   * `AT+SEL`, with the HALT-state workaround: after a completed select/deselect
   * cycle the tag sits in ISO14443 HALT state and this firmware cannot address
   * it, so every second select answers `<Tag timeout>` even though the tag is
   * healthy and inventory still reports it. Power-cycling the field resets the
   * tag to IDLE; one retry then succeeds.
   */
  private async select(uid: string): Promise<void> {
    try {
      await this.transport.command(`AT+SEL=${uid}`);
    } catch (error) {
      if (!isTagRemovedError(error)) throw error;
      await this.transport.command('AT+CW=0');
      await delay(50);
      await this.transport.command('AT+CW=1');
      await delay(50);
      await this.transport.command(`AT+SEL=${uid}`);
    }
  }

  private async readNdefState(): Promise<NdefState> {
    const lines = await this.transport.command('AT+CHKNDEF', this.options.ndefTimeoutMs);
    return stripPrefix(lines[0] ?? '', '+CHKNDEF:') as NdefState;
  }
}
