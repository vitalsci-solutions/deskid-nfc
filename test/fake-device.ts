/**
 * A fake DeskID NFC on a fake serial port, used by the tests in this folder.
 *
 * It emulates the behaviours that shaped this package rather than the whole AT
 * command set: the HALT-state select failure, the field on/off state, continuous
 * inventory that survives a port close, `<...>` error causes, and the odd line
 * framing (bare `\r`, NUL padding, chunks that split mid-line).
 */
import type { SerialPortInfoLike, SerialPortLike } from '../src/transport.js';

export interface FakeTag {
  uid: string;
  sak?: string;
  atqa?: string;
}

export interface FakeDeviceOptions {
  /** Response line terminator. Real hardware mostly uses `\r\n`, sometimes bare `\r`. */
  lineEnding?: string;
  /** Number of NUL padding bytes to prepend to every response (the device does this). */
  nulPadding?: number;
  /** Split responses into chunks of this many bytes (0 = one chunk per line). */
  chunkSize?: number;
  /** Tag lying on the antenna, if any. */
  tag?: FakeTag | null;
  /** NDEF message stored on the tag, as hex. `null` = no NDEF structure. */
  ndefHex?: string | null;
  /** Tag has an NDEF structure but no message (state `INITIALIZED`). */
  formatted?: boolean;
  /** Tag is write-protected (state `RO`). */
  readOnly?: boolean;
  /** Fail this many `AT` probes before answering, to exercise the probe retry. */
  probeFailures?: number;
  /** Reply to `ATI` with these values. */
  identity?: { firmware?: string; hardware?: string; serial?: string };
  /** Intercept a command before the default handling; return true when handled. */
  handle?: (cmd: string, device: FakeDevice) => boolean | void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A scripted DeskID NFC that speaks the AT protocol over an in-memory port. */
export class FakeDevice implements SerialPortLike {
  /** Every command received, in order — the main assertion surface for tests. */
  readonly commands: string[] = [];

  /** Every raw chunk written to the port, decoded but not de-framed. */
  readonly rawWrites: string[] = [];

  /**
   * Successful selections and deselections, as `sel:<uid>` / `del`. Failed
   * `AT+SEL` attempts are not recorded, so the log shows real tag sessions.
   */
  readonly selectLog: string[] = [];

  /** RF field state, as set by `AT+CW`. */
  field = false;
  /** Whether a continuous inventory is running (it survives `close()`, like the real one). */
  continuousInventory = false;
  /** Currently selected tag UID, or null. */
  selected: string | null = null;
  /**
   * ISO14443 HALT state. Set by `AT+DEL`; while set, `AT+SEL` fails with
   * `<Tag timeout>` until the RF field is power-cycled.
   */
  halted = false;
  /** How many times the port has been opened. */
  openCount = 0;
  isOpen = false;

  tag: FakeTag | null;
  ndefHex: string | null;
  formatted: boolean;
  readOnly: boolean;

  private readonly options: FakeDeviceOptions;
  private probeFailures: number;
  private rxBuffer = '';
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readableStream: ReadableStream<Uint8Array> | null = null;
  private writableStream: WritableStream<Uint8Array> | null = null;

  constructor(options: FakeDeviceOptions = {}) {
    this.options = options;
    this.tag = options.tag ?? null;
    this.ndefHex = options.ndefHex ?? null;
    this.formatted = options.formatted ?? options.ndefHex != null;
    this.readOnly = options.readOnly ?? false;
    this.probeFailures = options.probeFailures ?? 0;
  }

  // --- SerialPortLike ------------------------------------------------------

  get readable(): ReadableStream<Uint8Array> | null {
    return this.readableStream;
  }

  get writable(): WritableStream<Uint8Array> | null {
    return this.writableStream;
  }

  getInfo(): SerialPortInfoLike {
    return { usbVendorId: 0x2e8a, usbProductId: 0x000a };
  }

  async setSignals(): Promise<void> {}

  async open(): Promise<void> {
    if (this.isOpen) throw new Error("Failed to execute 'open' on 'SerialPort': The port is already open.");
    this.isOpen = true;
    this.openCount++;
    this.readableStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writableStream = new WritableStream<Uint8Array>({
      write: (chunk) => {
        const text = decoder.decode(chunk);
        this.rawWrites.push(text);
        this.receive(text);
      },
    });
  }

  async close(): Promise<void> {
    this.isOpen = false;
    try {
      this.controller?.close();
    } catch {
      // already closed by a cancelled reader
    }
    this.controller = null;
    this.readableStream = null;
    this.writableStream = null;
    this.selected = null;
    // Note: `continuousInventory` deliberately survives — that's the real bug.
  }

  // --- test helpers --------------------------------------------------------

  /** Emit an unsolicited `+CINV:` sighting, as a running inventory would. */
  pushInventoryEvent(tag: FakeTag | string): void {
    const value = typeof tag === 'string' ? tag : [tag.uid, tag.sak, tag.atqa].filter(Boolean).join(',');
    this.send(`+CINV: ${value}`);
  }

  /** Emit the idle round markers that flood the link ~50×/s. */
  pushIdleRound(): void {
    this.send('+CINV: <NO TAGS FOUND>');
    this.send('+CINV: <ROUND FINISHED>');
  }

  /** Push arbitrary bytes, bypassing line framing (for framing tests). */
  pushRaw(text: string): void {
    this.controller?.enqueue(encoder.encode(text));
  }

  /** Simulate an unplug: the readable stream ends. */
  pushDisconnect(): void {
    this.isOpen = false;
    try {
      this.controller?.close();
    } catch {
      // already gone
    }
  }

  /** Send one framed response line (with NUL padding / chunking applied). */
  send(line: string): void {
    const payload = '\0'.repeat(this.options.nulPadding ?? 0) + line + (this.options.lineEnding ?? '\r\n');
    const bytes = encoder.encode(payload);
    const size = this.options.chunkSize ?? 0;
    if (size <= 0) {
      this.controller?.enqueue(bytes);
      return;
    }
    for (let offset = 0; offset < bytes.length; offset += size) {
      this.controller?.enqueue(bytes.slice(offset, offset + size));
    }
  }

  /** Send zero or more data lines followed by `OK`. */
  ok(...lines: string[]): void {
    for (const line of lines) this.send(line);
    this.send('OK');
  }

  /** Send a `+PREFIX: <cause>` line followed by `ERROR`, like the real device. */
  fail(prefix: string, cause: string): void {
    this.send(`${prefix}: <${cause}>`);
    this.send('ERROR');
  }

  // --- command handling ----------------------------------------------------

  private receive(text: string): void {
    this.rxBuffer += text;
    let index = this.rxBuffer.indexOf('\r');
    while (index !== -1) {
      const cmd = this.rxBuffer.slice(0, index).trim();
      this.rxBuffer = this.rxBuffer.slice(index + 1);
      if (cmd.length > 0) {
        this.commands.push(cmd);
        this.handle(cmd);
      }
      index = this.rxBuffer.indexOf('\r');
    }
  }

  private get ndefState(): string {
    if (this.readOnly) return 'RO';
    if (this.ndefHex) return 'RW';
    if (this.formatted) return 'INITIALIZED';
    return 'NO NDEF';
  }

  private requireSelected(prefix: string): boolean {
    if (this.selected) return true;
    this.fail(prefix, 'No Tag selected');
    return false;
  }

  private handle(cmd: string): void {
    if (this.options.handle?.(cmd, this) === true) return;

    if (cmd === 'AT') {
      if (this.probeFailures > 0) {
        this.probeFailures--;
        return; // silence — the transport must retry
      }
      this.send('OK');
      return;
    }

    if (cmd === 'ATI') {
      const id = this.options.identity ?? {};
      // The real ATI pads its labels with runs of spaces.
      this.ok(
        `+SW: ${id.firmware ?? 'DeskID_NFC       0208'}`,
        `+HW: ${id.hardware ?? 'DeskID_NFC       0103'}`,
        `+SERIAL: ${id.serial ?? '2024022112041465'}`,
      );
      return;
    }

    if (cmd.startsWith('AT+MOD=') || cmd.startsWith('AT+INVS=') || cmd.startsWith('AT+FDB=')) {
      this.send('OK');
      return;
    }

    if (cmd === 'AT+CW=1' || cmd === 'AT+CW=0') {
      const on = cmd.endsWith('1');
      // A field power-cycle resets tags from HALT back to IDLE.
      if (on && !this.field) this.halted = false;
      this.field = on;
      this.send('OK');
      return;
    }

    if (cmd === 'AT+CW?') {
      this.ok(`+CW: ${this.field ? 1 : 0}`);
      return;
    }

    if (cmd === 'AT+CINV') {
      this.continuousInventory = true;
      this.send('OK');
      return;
    }

    if (cmd === 'AT+BINV') {
      if (!this.continuousInventory) {
        this.fail('+BINV', 'Continuous scan is not running');
        return;
      }
      this.continuousInventory = false;
      this.send('OK');
      return;
    }

    if (cmd === 'AT+INV') {
      if (!this.tag || !this.field) {
        this.ok('+INV: <NO TAGS FOUND>');
        return;
      }
      this.ok(`+INV: ${[this.tag.uid, this.tag.sak, this.tag.atqa].filter(Boolean).join(',')}`);
      return;
    }

    if (cmd.startsWith('AT+SEL=')) {
      const uid = cmd.slice('AT+SEL='.length);
      if (!/^[0-9A-Fa-f]+$/.test(uid)) {
        this.send('ERROR'); // a UID with its ,SAK,ATQA suffix still attached
        return;
      }
      if (!this.tag || uid !== this.tag.uid) {
        this.fail('+SEL', 'Tag timeout');
        return;
      }
      if (this.halted) {
        this.fail('+SEL', 'Tag timeout'); // needs a field power-cycle first
        return;
      }
      this.selected = uid;
      this.selectLog.push(`sel:${uid}`);
      this.send('OK');
      return;
    }

    if (cmd === 'AT+DEL') {
      if (this.selected) this.selectLog.push('del');
      this.selected = null;
      this.halted = true; // the tag parks in HALT after a completed cycle
      this.send('OK');
      return;
    }

    if (cmd === 'AT+CHKNDEF') {
      if (!this.requireSelected('+CHKNDEF')) return;
      this.ok(`+CHKNDEF: ${this.ndefState}`);
      return;
    }

    if (cmd === 'AT+RDNDEF') {
      if (!this.requireSelected('+RDNDEF')) return;
      if (this.ndefHex) this.ok(`+RDNDEF: ${this.ndefHex}`);
      else this.ok();
      return;
    }

    if (cmd.startsWith('AT+WRTNDEF=')) {
      if (!this.requireSelected('+WRTNDEF')) return;
      if (this.readOnly) {
        this.fail('+WRTNDEF', 'NTAG EEPROM failure (maybe locked?)');
        return;
      }
      this.ndefHex = cmd.slice('AT+WRTNDEF='.length);
      this.formatted = true;
      this.send('OK');
      return;
    }

    if (cmd === 'AT+FMTNDEF') {
      if (!this.requireSelected('+FMTNDEF')) return;
      this.formatted = true;
      this.ndefHex = null;
      this.send('OK');
      return;
    }

    this.send('ERROR');
  }
}
