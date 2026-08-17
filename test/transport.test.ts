import { describe, expect, test } from 'bun:test';
import { ReaderError } from '../src/errors.js';
import { SerialTransport, type LogEntry, type TransportOptions } from '../src/transport.js';
import { FakeDevice, type FakeDeviceOptions } from './fake-device.js';

/** Open a transport against a fake device, with test-speed timings. */
async function openTransport(
  deviceOptions: FakeDeviceOptions = {},
  transportOptions: TransportOptions = {},
): Promise<{ device: FakeDevice; transport: SerialTransport }> {
  const device = new FakeDevice(deviceOptions);
  const transport = new SerialTransport({ settleMs: 0, commandTimeoutMs: 200, ...transportOptions });
  await transport.open(device);
  device.commands.length = 0; // drop the AT probe so tests assert on their own traffic
  return { device, transport };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('opening', () => {
  test('probes with AT and retries a silent reader', async () => {
    const device = new FakeDevice({ probeFailures: 2 });
    const transport = new SerialTransport({ settleMs: 0, commandTimeoutMs: 50 });
    await transport.open(device);
    expect(device.commands).toEqual(['AT', 'AT', 'AT']);
    await transport.close();
  });

  test('fails with a timeout when the reader never answers', async () => {
    const device = new FakeDevice({ probeFailures: 99 });
    const transport = new SerialTransport({ settleMs: 0, commandTimeoutMs: 20 });
    await expect(transport.open(device)).rejects.toThrow(/not responding to the AT probe/i);
    expect(transport.isOpen).toBe(false);
    expect(device.isOpen).toBe(false); // the port is released again, not left dangling
  });

  test('reclaims a port left open by a previous session', async () => {
    const device = new FakeDevice();
    await device.open(); // e.g. a hot-reloaded module that never closed
    const transport = new SerialTransport({ settleMs: 0, commandTimeoutMs: 200 });
    await transport.open(device);
    expect(device.openCount).toBe(2);
    expect(transport.isOpen).toBe(true);
    await transport.close();
  });

  test('reports the port USB ids', async () => {
    const { transport } = await openTransport();
    expect(transport.portInfo).toEqual({ usbVendorId: 0x2e8a, usbProductId: 0x000a });
    await transport.close();
  });
});

describe('command framing', () => {
  test('returns the data lines received before OK', async () => {
    const { transport } = await openTransport();
    expect(await transport.command('ATI')).toEqual([
      '+SW: DeskID_NFC       0208',
      '+HW: DeskID_NFC       0103',
      '+SERIAL: 2024022112041465',
    ]);
    await transport.close();
  });

  test('terminates commands with CR only, never CRLF', async () => {
    const { device, transport } = await openTransport();
    await transport.command('AT');
    expect(device.rawWrites).toEqual(['AT\r', 'AT\r']); // the probe, then ours
    await transport.close();
  });

  test('rejects with the <cause> reported before ERROR', async () => {
    const { transport } = await openTransport();
    const error = (await transport.command('AT+CHKNDEF').catch((e: unknown) => e)) as ReaderError;
    expect(error).toBeInstanceOf(ReaderError);
    expect(error.message).toBe('No Tag selected');
    expect(error.code).toBe('device');
    expect(error.command).toBe('AT+CHKNDEF');
    await transport.close();
  });

  test('rejects with a fallback message for a bare ERROR', async () => {
    const { transport } = await openTransport();
    await expect(transport.command('AT+NOPE')).rejects.toThrow('AT+NOPE failed');
    await transport.close();
  });

  test('times out with code "timeout" when nothing answers', async () => {
    const { transport } = await openTransport({ handle: (cmd) => cmd === 'AT+QUIET' });
    const error = (await transport.command('AT+QUIET', 30).catch((e: unknown) => e)) as ReaderError;
    expect(error.code).toBe('timeout');
    // A timed-out command must not poison the queue for the next one.
    expect(await transport.command('AT')).toEqual([]);
    await transport.close();
  });

  test('serializes concurrent commands instead of interleaving them', async () => {
    const { device, transport } = await openTransport();
    const results = await Promise.all([transport.command('ATI'), transport.command('AT'), transport.command('ATI')]);
    expect(device.commands).toEqual(['ATI', 'AT', 'ATI']);
    expect(results[0]).toHaveLength(3);
    expect(results[1]).toEqual([]);
    await transport.close();
  });
});

describe('line parsing quirks', () => {
  test('parses responses split into single-byte chunks, with bare CR and NUL padding', async () => {
    const { transport } = await openTransport({ lineEnding: '\r', nulPadding: 3, chunkSize: 1 });
    expect(await transport.command('ATI')).toHaveLength(3);
    await transport.close();
  });

  test('collapses runs of delimiters and drops empty lines', async () => {
    const { transport } = await openTransport({
      handle: (cmd, device) => {
        if (cmd !== 'AT+WEIRD') return false;
        device.pushRaw('\r\n\r\n+X: 1\r\r\n\n\0\0OK\r\n');
        return true;
      },
    });
    expect(await transport.command('AT+WEIRD')).toEqual(['+X: 1']);
    await transport.close();
  });
});

describe('unsolicited inventory events', () => {
  test('routes +CINV events to the handler and filters idle round markers', async () => {
    const seen: string[] = [];
    const { device, transport } = await openTransport({}, { onInventoryEvent: (value) => seen.push(value) });
    device.pushIdleRound();
    device.pushInventoryEvent({ uid: '901974A2429B04', sak: '00', atqa: '4400' });
    device.pushIdleRound();
    await tick();
    expect(seen).toEqual(['901974A2429B04,00,4400']);
    await transport.close();
  });

  test('keeps an event that interleaves a pending command response out of that response', async () => {
    const seen: string[] = [];
    const { transport } = await openTransport(
      {
        handle: (cmd, device) => {
          if (cmd !== 'ATI') return false;
          device.send('+SW: DeskID_NFC       0208');
          device.pushInventoryEvent('AABBCCDD'); // arrives mid-block, as it does on hardware
          device.ok('+SERIAL: 1');
          return true;
        },
      },
      { onInventoryEvent: (value) => seen.push(value) },
    );
    expect(await transport.command('ATI')).toEqual(['+SW: DeskID_NFC       0208', '+SERIAL: 1']);
    expect(seen).toEqual(['AABBCCDD']);
    await transport.close();
  });

  test('does not log the ~50/s idle markers', async () => {
    const logs: LogEntry[] = [];
    const { device, transport } = await openTransport({}, { onLog: (entry) => logs.push(entry) });
    device.pushIdleRound();
    await tick();
    expect(logs.filter((entry) => entry.text.includes('CINV'))).toEqual([]);
    await transport.close();
  });
});

describe('closing', () => {
  test('releases the port so it can be opened again', async () => {
    const { device, transport } = await openTransport();
    await transport.close();
    expect(transport.isOpen).toBe(false);
    expect(device.isOpen).toBe(false);
    await transport.open(device); // would throw "already open" if teardown had raced
    expect(device.openCount).toBe(2);
    await transport.close();
  });

  test('is a no-op when already closed', async () => {
    const { transport } = await openTransport();
    await transport.close();
    await expect(transport.close()).resolves.toBeUndefined();
  });

  test('rejects commands issued after closing', async () => {
    const { transport } = await openTransport();
    await transport.close();
    const error = (await transport.command('AT').catch((e: unknown) => e)) as ReaderError;
    expect(error.code).toBe('not-connected');
  });

  test('reports an unplug through onLost and fails the pending command', async () => {
    const lost: Error[] = [];
    const { device, transport } = await openTransport(
      { handle: (cmd) => cmd === 'AT+SLOW' },
      { onLost: (error) => lost.push(error) },
    );
    const pending = transport.command('AT+SLOW', 500);
    device.pushDisconnect();
    const error = (await pending.catch((e: unknown) => e)) as ReaderError;
    expect(error.code).toBe('disconnected');
    await tick();
    expect(lost).toHaveLength(1);
    expect(transport.isOpen).toBe(false);
  });
});
