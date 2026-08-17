import { describe, expect, test } from 'bun:test';
import { DeskIdNfc, type DeskIdNfcOptions, type Tag } from '../src/reader.js';
import { ReaderError, isTagRemovedError } from '../src/errors.js';
import { FakeDevice, type FakeDeviceOptions } from './fake-device.js';

const TAG = { uid: '901974A2429B04', sak: '00', atqa: '4400' };
/** A text record reading "moin" — the first message written to the real device. */
const MOIN_HEX = 'D101075402656E6D6F696E';

/** Open a reader against a fake device, with test-speed timings. */
async function openReader(
  deviceOptions: FakeDeviceOptions = {},
  readerOptions: DeskIdNfcOptions = {},
): Promise<{ device: FakeDevice; nfc: DeskIdNfc }> {
  const device = new FakeDevice({ tag: TAG, ...deviceOptions });
  const nfc = new DeskIdNfc({
    settleMs: 0,
    commandTimeoutMs: 200,
    ndefTimeoutMs: 200,
    presenceTimeoutMs: 60,
    presencePollMs: 10,
    ...readerOptions,
  });
  await nfc.open(device);
  return { device, nfc };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('open', () => {
  test('runs the init sequence that works on hardware, stale scan first', async () => {
    const { device, nfc } = await openReader();
    expect(device.commands).toEqual([
      'AT', // liveness probe
      'AT+BINV', // clear a continuous inventory left running in the firmware
      'AT+MOD=ISO14A',
      'AT+INVS=1,0,0',
      'AT+CW=1', // keep the RF field energized for the whole session
      'ATI',
      'AT+CINV', // start watching
    ]);
    expect(device.field).toBe(true);
    expect(device.continuousInventory).toBe(true);
    await nfc.close();
  });

  test('parses ATI, normalizing the multi-space separator', async () => {
    const { nfc } = await openReader();
    expect(nfc.info).toEqual({
      firmware: 'DeskID_NFC 0208',
      hardware: 'DeskID_NFC 0103',
      serial: '2024022112041465',
    });
    await nfc.close();
  });

  test('tolerates a reader that reports no continuous scan is running', async () => {
    // AT+BINV answers ERROR "<...is not running>" on a freshly powered reader.
    const { device, nfc } = await openReader();
    expect(device.commands).toContain('AT+BINV');
    expect(nfc.isOpen).toBe(true);
    await nfc.close();
  });

  test('can be opened without starting the watch loop', async () => {
    const { device, nfc } = await openReader({}, { watch: false });
    expect(device.commands).not.toContain('AT+CINV');
    expect(nfc.isWatching).toBe(false);
    await nfc.close();
  });

  test('honours the ISO15693 mode option', async () => {
    const { device, nfc } = await openReader({}, { mode: 'ISO15' });
    expect(device.commands).toContain('AT+MOD=ISO15');
    await nfc.close();
  });

  test('refuses to open twice', async () => {
    const { nfc } = await openReader();
    await expect(nfc.open(new FakeDevice())).rejects.toThrow(/already open/i);
    await nfc.close();
  });
});

describe('tag presence', () => {
  test('emits tag on an inventory sighting and exposes it as currentTag', async () => {
    const { device, nfc } = await openReader();
    const seen: Tag[] = [];
    nfc.on('tag', (tag) => seen.push(tag));

    device.pushInventoryEvent(TAG);
    await tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ uid: TAG.uid, sak: '00', atqa: '4400' });
    expect(nfc.currentTag?.uid).toBe(TAG.uid);
    await nfc.close();
  });

  test('emits tag once per presence episode, not per inventory round', async () => {
    const { device, nfc } = await openReader();
    let arrivals = 0;
    nfc.on('tag', () => arrivals++);

    for (let i = 0; i < 5; i++) {
      device.pushInventoryEvent(TAG);
      await tick(1);
    }

    expect(arrivals).toBe(1);
    await nfc.close();
  });

  test('emits tagleft once sightings stop', async () => {
    const { device, nfc } = await openReader();
    const left: Tag[] = [];
    nfc.on('tagleft', (tag) => left.push(tag));

    device.pushInventoryEvent(TAG);
    await tick();
    expect(nfc.currentTag).not.toBeNull();

    await tick(100); // longer than presenceTimeoutMs
    expect(left.map((tag) => tag.uid)).toEqual([TAG.uid]);
    expect(nfc.currentTag).toBeNull();
    await nfc.close();
  });

  test('treats a swapped tag as leave-then-arrive', async () => {
    const { device, nfc } = await openReader();
    const events: string[] = [];
    nfc.on('tag', (tag) => events.push(`+${tag.uid}`));
    nfc.on('tagleft', (tag) => events.push(`-${tag.uid}`));

    device.pushInventoryEvent(TAG);
    device.pushInventoryEvent({ uid: 'AABBCCDD' });
    await tick();

    expect(events).toEqual([`+${TAG.uid}`, `-${TAG.uid}`, '+AABBCCDD']);
    await nfc.close();
  });

  test('single-shot inventory reports what is on the antenna', async () => {
    const { nfc } = await openReader();
    const tags = await nfc.inventory();
    expect(tags.map((tag) => tag.uid)).toEqual([TAG.uid]);
    await nfc.close();
  });

  test('single-shot inventory reports emptiness as data, not an error', async () => {
    const { nfc } = await openReader({ tag: null });
    expect(await nfc.inventory()).toEqual([]);
    await nfc.close();
  });
});

describe('read', () => {
  test('pauses the watch, selects, reads, deselects, resumes', async () => {
    const { device, nfc } = await openReader({ ndefHex: MOIN_HEX });
    device.commands.length = 0;

    const result = await nfc.read(TAG.uid);

    expect(device.commands).toEqual([
      'AT+BINV',
      `AT+SEL=${TAG.uid}`,
      'AT+CHKNDEF',
      'AT+RDNDEF',
      'AT+DEL',
      'AT+CINV',
    ]);
    expect(result).toEqual({
      uid: TAG.uid,
      state: 'RW',
      hex: MOIN_HEX,
      records: [{ kind: 'text', lang: 'en', text: 'moin' }],
    });
    expect(nfc.isWatching).toBe(true);
    await nfc.close();
  });

  test('defaults to the tag currently on the reader', async () => {
    const { device, nfc } = await openReader({ ndefHex: MOIN_HEX });
    device.pushInventoryEvent(TAG);
    await tick();
    expect((await nfc.read()).uid).toBe(TAG.uid);
    await nfc.close();
  });

  test('throws no-tag when nothing is on the reader', async () => {
    const { nfc } = await openReader();
    const error = (await nfc.read().catch((e: unknown) => e)) as ReaderError;
    expect(error.code).toBe('no-tag');
    await nfc.close();
  });

  test('power-cycles the field and retries when the tag sits in HALT state', async () => {
    const { device, nfc } = await openReader({ ndefHex: MOIN_HEX });
    device.halted = true; // where a tag ends up after any previous select/deselect
    device.commands.length = 0;

    const result = await nfc.read(TAG.uid);

    expect(device.commands).toEqual([
      'AT+BINV',
      `AT+SEL=${TAG.uid}`, // <Tag timeout>
      'AT+CW=0',
      'AT+CW=1', // field cycle resets the tag to IDLE
      `AT+SEL=${TAG.uid}`, // succeeds
      'AT+CHKNDEF',
      'AT+RDNDEF',
      'AT+DEL',
      'AT+CINV',
    ]);
    expect(result.records).toEqual([{ kind: 'text', lang: 'en', text: 'moin' }]);
    await nfc.close();
  });

  test('back-to-back reads both succeed despite HALT after each one', async () => {
    const { nfc } = await openReader({ ndefHex: MOIN_HEX });
    expect((await nfc.read(TAG.uid)).state).toBe('RW');
    expect((await nfc.read(TAG.uid)).state).toBe('RW');
    await nfc.close();
  });

  test('reports an unformatted tag as NO NDEF instead of failing', async () => {
    const { device, nfc } = await openReader({ ndefHex: null, formatted: false });
    device.commands.length = 0;

    const result = await nfc.read(TAG.uid);

    expect(result).toEqual({ uid: TAG.uid, state: 'NO NDEF', hex: '', records: [] });
    expect(device.commands).not.toContain('AT+RDNDEF'); // nothing to read
    await nfc.close();
  });

  test('reports a formatted but empty tag with no records', async () => {
    const { nfc } = await openReader({ ndefHex: null, formatted: true });
    expect(await nfc.read(TAG.uid)).toEqual({ uid: TAG.uid, state: 'INITIALIZED', hex: '', records: [] });
    await nfc.close();
  });

  test('surfaces malformed tag content with the raw hex attached', async () => {
    const { nfc } = await openReader({ ndefHex: 'D1010754026E' }); // truncated payload
    const error = (await nfc.read(TAG.uid).catch((e: unknown) => e)) as ReaderError;
    expect(error.message).toMatch(/could not decode/i);
    expect(error.message).toContain('D1010754026E');
    await nfc.close();
  });

  test('checkNdef reports the state without reading content', async () => {
    const { device, nfc } = await openReader({ readOnly: true });
    device.commands.length = 0;
    expect(await nfc.checkNdef(TAG.uid)).toBe('RO');
    expect(device.commands).not.toContain('AT+RDNDEF');
    await nfc.close();
  });
});

describe('write', () => {
  test('writes, beeps, and verifies by reading back', async () => {
    const { device, nfc } = await openReader({ ndefHex: null, formatted: true });
    device.commands.length = 0;

    const verified = await nfc.write({ kind: 'text', lang: 'en', text: 'moin' }, { uid: TAG.uid });

    expect(device.commands).toEqual([
      'AT+BINV',
      `AT+SEL=${TAG.uid}`,
      'AT+CHKNDEF',
      `AT+WRTNDEF=${MOIN_HEX}`,
      'AT+FDB=1', // success buzz
      'AT+DEL',
      'AT+CINV',
      // verification is a fresh selection, which exercises the HALT wake-up
      'AT+BINV',
      `AT+SEL=${TAG.uid}`,
      'AT+CW=0',
      'AT+CW=1',
      `AT+SEL=${TAG.uid}`,
      'AT+CHKNDEF',
      'AT+RDNDEF',
      'AT+DEL',
      'AT+CINV',
    ]);
    expect(verified?.records).toEqual([{ kind: 'text', lang: 'en', text: 'moin' }]);
    expect(device.ndefHex).toBe(MOIN_HEX);
    await nfc.close();
  });

  test('formats a tag that has no NDEF structure first', async () => {
    const { device, nfc } = await openReader({ ndefHex: null, formatted: false });
    device.commands.length = 0;
    await nfc.write({ kind: 'uri', uri: 'https://example.com' }, { uid: TAG.uid, verify: false });
    expect(device.commands).toContain('AT+FMTNDEF');
    await nfc.close();
  });

  test('skips verification (and the second selection) when asked to', async () => {
    const { device, nfc } = await openReader({ formatted: true });
    device.commands.length = 0;
    expect(await nfc.write({ kind: 'text', lang: 'en', text: 'x' }, { uid: TAG.uid, verify: false })).toBeNull();
    expect(device.commands.filter((cmd) => cmd.startsWith('AT+SEL='))).toHaveLength(1);
    await nfc.close();
  });

  test('round-trips multiple records', async () => {
    const { nfc } = await openReader({ formatted: true });
    const records = [
      { kind: 'text' as const, lang: 'en', text: 'Meeting room 3' },
      { kind: 'uri' as const, uri: 'https://intranet.test/room/3' },
    ];
    const verified = await nfc.write(records, { uid: TAG.uid });
    expect(verified?.records).toEqual(records);
    await nfc.close();
  });

  test('refuses a write-protected tag before touching it', async () => {
    const { device, nfc } = await openReader({ readOnly: true });
    device.commands.length = 0;
    await expect(nfc.write({ kind: 'text', lang: 'en', text: 'x' }, { uid: TAG.uid })).rejects.toThrow(
      /write-protected/i,
    );
    expect(device.commands.some((cmd) => cmd.startsWith('AT+WRTNDEF='))).toBe(false);
    await nfc.close();
  });

  test('buzzes the failure tone and surfaces the reader message on a failed write', async () => {
    const { device, nfc } = await openReader({
      formatted: true,
      handle: (cmd, dev) => {
        if (!cmd.startsWith('AT+WRTNDEF=')) return false;
        dev.fail('+WRTNDEF', 'NTAG EEPROM failure (maybe locked?)');
        return true;
      },
    });
    device.commands.length = 0;

    await expect(nfc.write({ kind: 'text', lang: 'en', text: 'x' }, { uid: TAG.uid })).rejects.toThrow(
      'NTAG EEPROM failure (maybe locked?)',
    );
    expect(device.commands).toContain('AT+FDB=2');
    await nfc.close();
  });

  test('can be told not to buzz at all', async () => {
    const { device, nfc } = await openReader({ formatted: true }, { beepOnWrite: false });
    device.commands.length = 0;
    await nfc.write({ kind: 'text', lang: 'en', text: 'x' }, { uid: TAG.uid, verify: false });
    expect(device.commands.some((cmd) => cmd.startsWith('AT+FDB='))).toBe(false);
    await nfc.close();
  });

  test('format erases the tag content', async () => {
    const { device, nfc } = await openReader({ ndefHex: MOIN_HEX });
    await nfc.format(TAG.uid);
    expect(device.ndefHex).toBeNull();
    expect(await nfc.read(TAG.uid)).toMatchObject({ state: 'INITIALIZED', records: [] });
    await nfc.close();
  });
});

describe('a tag removed mid-operation', () => {
  test('is classified as removed-early and clears presence', async () => {
    const { device, nfc } = await openReader({ ndefHex: MOIN_HEX });
    device.pushInventoryEvent(TAG);
    await tick();

    const left: Tag[] = [];
    nfc.on('tagleft', (tag) => left.push(tag));
    device.tag = null; // lifted off the reader

    const error = (await nfc.read(TAG.uid).catch((e: unknown) => e)) as ReaderError;

    expect(error.message).toBe('Tag timeout');
    expect(isTagRemovedError(error)).toBe(true);
    expect(left.map((tag) => tag.uid)).toEqual([TAG.uid]);
    expect(nfc.currentTag).toBeNull();
    expect(nfc.isWatching).toBe(true); // the watch loop is resumed regardless
    await nfc.close();
  });

  test('does not classify an unrelated failure as removal', async () => {
    const { nfc } = await openReader({ readOnly: true });
    const error = (await nfc.write({ kind: 'text', lang: 'en', text: 'x' }, { uid: TAG.uid }).catch(
      (e: unknown) => e,
    )) as ReaderError;
    expect(isTagRemovedError(error)).toBe(false);
    await nfc.close();
  });
});

describe('serialization', () => {
  test('queues overlapping RF operations instead of interleaving selects', async () => {
    const { device, nfc } = await openReader({ ndefHex: MOIN_HEX });
    device.selectLog.length = 0;

    const results = await Promise.all([nfc.read(TAG.uid), nfc.read(TAG.uid), nfc.checkNdef(TAG.uid)]);

    // Each tag session is opened and closed before the next one starts.
    expect(device.selectLog).toEqual([`sel:${TAG.uid}`, 'del', `sel:${TAG.uid}`, 'del', `sel:${TAG.uid}`, 'del']);
    expect(results[0].records).toEqual([{ kind: 'text', lang: 'en', text: 'moin' }]);
    expect(results[2]).toBe('RW');
    await nfc.close();
  });

  test('queues a read behind a write on the same tag', async () => {
    const { device, nfc } = await openReader({ formatted: true });
    device.selectLog.length = 0;

    const [written, read] = await Promise.all([
      nfc.write({ kind: 'text', lang: 'en', text: 'moin' }, { uid: TAG.uid, verify: false }),
      nfc.read(TAG.uid),
    ]);

    expect(written).toBeNull();
    // The read is queued after the write, so it sees the new content.
    expect(read.records).toEqual([{ kind: 'text', lang: 'en', text: 'moin' }]);
    expect(device.selectLog).toEqual([`sel:${TAG.uid}`, 'del', `sel:${TAG.uid}`, 'del']);
    await nfc.close();
  });
});

describe('close', () => {
  test('stops the scan, switches the field off, and releases the port', async () => {
    const { device, nfc } = await openReader();
    const reasons: string[] = [];
    nfc.on('close', (reason) => reasons.push(reason));
    device.commands.length = 0;

    await nfc.close();

    expect(device.commands).toEqual(['AT+BINV', 'AT+CW=0']);
    expect(device.continuousInventory).toBe(false);
    expect(device.field).toBe(false);
    expect(device.isOpen).toBe(false);
    expect(nfc.isOpen).toBe(false);
    expect(nfc.info).toBeNull();
    expect(reasons).toEqual(['requested']);
  });

  test('is a no-op when already closed', async () => {
    const { nfc } = await openReader();
    await nfc.close();
    await expect(nfc.close()).resolves.toBeUndefined();
  });

  test('reports an unplug as close("lost")', async () => {
    const { device, nfc } = await openReader();
    const reasons: string[] = [];
    nfc.on('close', (reason) => reasons.push(reason));
    device.pushInventoryEvent(TAG);
    await tick();

    device.pushDisconnect();
    await tick();

    expect(reasons).toEqual(['lost']);
    expect(nfc.isOpen).toBe(false);
    expect(nfc.currentTag).toBeNull();
  });

  test('lets the same reader instance reconnect afterwards', async () => {
    const { device, nfc } = await openReader();
    await nfc.close();
    await nfc.open(device);
    expect(nfc.isOpen).toBe(true);
    expect(nfc.info?.serial).toBe('2024022112041465');
    await nfc.close();
  });
});

describe('diagnostics', () => {
  test('logs every command and response line', async () => {
    const { nfc } = await openReader();
    const lines: string[] = [];
    nfc.on('log', (entry) => lines.push(`${entry.direction} ${entry.text}`));
    await nfc.command('AT+CW?');
    expect(lines).toContain('tx AT+CW?');
    expect(lines).toContain('rx +CW: 1');
    await nfc.close();
  });

  test('exposes a raw command escape hatch', async () => {
    const { nfc } = await openReader();
    expect(await nfc.command('AT+CW?')).toEqual(['+CW: 1']);
    await nfc.close();
  });

  test('routes a throwing event listener to the error event', async () => {
    const { device, nfc } = await openReader();
    const errors: Error[] = [];
    nfc.on('error', (error) => errors.push(error));
    nfc.on('tag', () => {
      throw new Error('listener blew up');
    });

    device.pushInventoryEvent(TAG);
    await tick();

    expect(errors.map((error) => error.message)).toEqual(['listener blew up']);
    await nfc.close();
  });

  test('routes a rejecting async listener to the error event', async () => {
    const { device, nfc } = await openReader();
    const errors: Error[] = [];
    nfc.on('error', (error) => errors.push(error));
    nfc.on('tag', async () => {
      throw new Error('async listener blew up');
    });

    device.pushInventoryEvent(TAG);
    await tick();

    expect(errors.map((error) => error.message)).toEqual(['async listener blew up']);
    await nfc.close();
  });
});
