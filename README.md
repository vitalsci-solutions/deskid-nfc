# deskid-nfc

Browser driver for the **Metratec DeskID NFC** desk reader over [WebSerial][webserial]:
tag presence events, NDEF read/write, no dependencies.

[Landing page](https://vitalsci-solutions.github.io/deskid-nfc/) ·
[npm](https://www.npmjs.com/package/deskid-nfc) ·
[Issues](https://github.com/vitalsci-solutions/deskid-nfc/issues)

The reader speaks an AT-style line protocol over USB CDC. Doing that by hand works
until it doesn't — four firmware behaviours cause almost all of the pain, and this
package handles all four for you:

| Behaviour | What you'd see | What this package does |
|---|---|---|
| The RF field idles off | `<NO TAGS FOUND>` with a tag sitting on the antenna | keeps the field on (`AT+CW=1`) for the whole session |
| Tags park in ISO14443 HALT state | *every second* read fails with `<Tag timeout>` | power-cycles the field and retries the select |
| Continuous inventory outlives the port | tag events for a scan you never started, colliding with reads | stops any stale scan at connect, and its own at close |
| Inventory floods the link (~50 lines/s) | a drowned log pipeline and a starved UI | filters idle round markers in the transport |

Verified against a DeskID NFC on firmware **2.08** (hardware 0103) with NTAG213 tags.

[webserial]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API

## Install

```sh
bun add deskid-nfc     # or: npm i deskid-nfc
```

Requirements: a Chromium-based browser (Chrome, Edge, Arc, Brave) on HTTPS or
`localhost`. No driver or native module — the reader enumerates as CDC-ACM.
Firefox and Safari do not implement WebSerial; check with `DeskIdNfc.isSupported()`.

## Quick start

```ts
import { DeskIdNfc, ndefRecordToString } from 'deskid-nfc';

const nfc = new DeskIdNfc();

nfc.on('tag', async (tag) => {
  const { state, records } = await nfc.read(tag.uid);
  console.log(tag.uid, state, records.map(ndefRecordToString));
});

nfc.on('tagleft', (tag) => console.log('removed', tag.uid));
nfc.on('close', (reason) => console.log('disconnected:', reason));

// WebSerial shows a port picker, so this must run inside a user gesture
connectButton.addEventListener('click', async () => {
  const info = await nfc.open();
  console.log(`DeskID NFC ${info.firmware}, serial ${info.serial}`);
});

// leaving the page without this leaves the reader scanning and radiating
addEventListener('beforeunload', () => void nfc.close());
```

Writing is one call, and verifies by reading the tag back:

```ts
await nfc.write({ kind: 'text', lang: 'en', text: 'moin' });
await nfc.write({ kind: 'uri', uri: 'https://example.com' });
await nfc.write([
  { kind: 'text', lang: 'en', text: 'Meeting room 3' },
  { kind: 'uri', uri: 'https://intranet.test/room/3' },
]);
```

With no `uid` argument, read/write target the tag currently on the reader.

## Interaction model

Continuous inventory runs the whole time the port is open, so tag presence is
event-driven — there is no "scan" call to poll:

- `tag` fires when a tag lands on the reader (or is swapped for a different one),
- `tagleft` fires when no inventory round has seen it for `presenceTimeoutMs` (1.5 s),
  or when an operation proves it is gone.

`read()`, `write()`, `format()` and `inventory()` pause that loop, do their work, and
resume it — you never have to. They are also serialized against each other: calling
two of them at once queues rather than interleaving, because concurrent select-based
commands fail in confusing ways.

Two UX habits worth copying from the app this package was extracted from:

- **Read on arrival** rather than behind a button — separate "scan" and "read"
  buttons confuse people, since a tag on the pad is already "scanned".
- **Arm writes before the tag arrives** ("press Write, then place a tag"): keep the
  record around and write it from your `tag` handler. If a write fails with
  `isTagRemovedError`, keep it armed so putting the tag back retries automatically.

## API

### `new DeskIdNfc(options?)`

| Option | Default | Meaning |
|---|---|---|
| `mode` | `'ISO14A'` | Tag family to poll for. `'ISO15'` for ISO15693 vicinity tags (untested). |
| `watch` | `true` | Start continuous inventory (and `tag` events) on `open()`. |
| `presenceTimeoutMs` | `1500` | A tag counts as gone after this long without a sighting. |
| `presencePollMs` | `300` | How often presence is re-evaluated. |
| `beepOnWrite` | `true` | Buzz the reader on write success/failure. |
| `commandTimeoutMs` | `2000` | Per-command response timeout. |
| `ndefTimeoutMs` | `5000` | Timeout for NDEF read/write/format. |
| `baudRate` | `115200` | Don't change it; the reader is fixed at 115200. |
| `settleMs` | `200` | Delay between opening the port and the first `AT` probe. |
| `onLog` | – | Same payload as the `log` event, but wired up before `open()` runs. |

### Methods

| Method | Description |
|---|---|
| `open(port?)` | Open a port, initialize, start watching. Returns `ReaderInfo`. Omit `port` to show the browser picker; pass one from `navigator.serial.getPorts()` to reconnect silently. |
| `close()` | Stop scanning, switch the field off, release the port. Safe to call twice. |
| `read(uid?)` | Read and decode the NDEF message. Returns `{ uid, state, hex, records }`. |
| `write(records, { uid?, verify? })` | Encode and write records, formatting the tag first if needed. Returns the verification read (default) or `null`. |
| `writeHex(hex, options?)` | Same, for a pre-encoded message. |
| `checkNdef(uid?)` | NDEF state only: `RW`, `RO`, `NO NDEF`, `INITIALIZED`, `MISCONFIGURED`. |
| `format(uid?)` | Write an empty NDEF structure, erasing the content. |
| `inventory()` | One-shot inventory round. Prefer the `tag` event. |
| `beep('ok' \| 'error')` | Sound the buzzer. |
| `command(cmd, timeoutMs?)` | Raw AT command, serialized against the package's own traffic. |
| `on(event, listener)` | Subscribe; returns an unsubscribe function. `off()` also exists. |

Properties: `isOpen`, `isWatching`, `info`, `currentTag`, `portInfo`.
Static: `DeskIdNfc.isSupported()`.

### Events

| Event | Payload | When |
|---|---|---|
| `tag` | `Tag` | A tag arrived (or was swapped). |
| `tagleft` | `Tag` | The tag left, or an operation proved it gone. |
| `log` | `LogEntry` | Every TX/RX line and lifecycle note. |
| `error` | `Error` | Background failure: the watch loop, or a throwing listener. |
| `close` | `'requested' \| 'lost'` | `close()` was called, or the device was unplugged. |

Async listeners are fine; a rejection surfaces as an `error` event instead of an
unhandled rejection.

### Errors

Everything throws `ReaderError`, carrying the reader's own `<...>` message
verbatim (`Tag timeout`, `No Tag selected`, `NTAG EEPROM failure (maybe locked?)`)
plus a `code`: `device`, `timeout`, `disconnected`, `not-connected`, `no-tag`,
`unsupported`.

The failure to handle separately is a tag moved away mid-operation — by far the most
common one in practice:

```ts
import { isTagRemovedError } from 'deskid-nfc';

try {
  await nfc.write(record);
} catch (error) {
  if (isTagRemovedError(error)) {
    // for a write this means the content may be partially written
    setHint('Keep the tag on the reader until the beep');
  } else {
    throw error;
  }
}
```

### NDEF codec

Usable standalone, with no hardware and no reader instance:

```ts
import { encodeNdefMessage, decodeNdefMessage } from 'deskid-nfc';

encodeNdefMessage([{ kind: 'text', lang: 'en', text: 'moin' }]); // 'D101075402656E6D6F696E'
decodeNdefMessage('D101075402656E6D6F696E'); // [{ kind: 'text', lang: 'en', text: 'moin' }]
```

Short records (payload ≤ 255 bytes) with well-known types `T` (Text) and `U` (URI,
with the full prefix abbreviation table). Anything else decodes to
`{ kind: 'unknown', tnf, recordType, payloadHex }` so it can still be displayed.

### UIDs

The reader reports UIDs in the **opposite byte order** from phones and NXP tooling:
its `901974A2429B04` is the tag a phone shows as `04:9B:42:A2:74:19:90`. Always pass
the reader's own order back to `read()`/`write()`; convert only for display:

```ts
import { formatUid, reverseUid } from 'deskid-nfc';

formatUid(reverseUid(tag.uid)); // '04:9B:42:A2:74:19:90'
```

## Notes from the field

- **Don't filter the port picker by USB ids.** The reader is built on an RP2040 and
  reports the Raspberry Pi vendor id `0x2e8a`, which every RP2040 device shares.
  `open()` therefore asks with no filters; identify the reader afterwards via `info`.
- **Always `close()`**, including from your dev server's hot-reload dispose hook.
  A continuous inventory keeps running inside the reader's firmware after the port
  closes, and its rounds collide with the next session's reads.
  ```ts
  if (import.meta.hot) import.meta.hot.dispose(() => void nfc.close());
  ```
- **Metratec's Python SDK claims firmware ≥ 2.4** is needed for this model. 2.08
  handles the whole NDEF command set fine; don't gate features on that claim.
- **The blue LED tracks the RF field** per Metratec's guidance — but this package
  holds the field on for the entire session, so the LED is not a reliable
  "transfer in progress" indicator. Drive your own on-screen state from the events,
  and add a ~500 ms grace period before telling a user it is safe to remove the tag.
- **Wire up `log`.** Every hard-won diagnosis behind this package came out of a
  full TX/RX trace, not a UI-level log.

## Development

```sh
bun install
bun test        # 85 tests, no hardware needed
bun run check   # tsc --noEmit
bun run build   # dist/, ESM + .d.ts
```

The tests drive a scripted fake reader (`test/fake-device.ts`) that emulates the
awkward parts of the real one: HALT-state select failures, field state, `<...>` error
causes, bare-`\r` line endings, NUL padding, and responses split mid-line. Adding a
regression test for a hardware quirk usually means teaching the fake the quirk first.

`examples/index.html` is a no-build page for testing against a real reader:

```sh
bun run build && bunx serve .   # then open /examples/
```

`docs/` is the landing page served by GitHub Pages (source: `main` branch, `/docs`
folder). It is a single self-contained HTML file with no build step; `docs/og.png` is
rendered from `docs/_og-source.html` at 1200x630.

## License

MIT
