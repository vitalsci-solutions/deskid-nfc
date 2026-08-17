/**
 * Minimal, dependency-free NDEF message codec.
 *
 * Encodes and decodes NDEF messages built from *short records* (SR = 1, payload
 * ≤ 255 bytes) with the NFC Forum well-known types `T` (Text) and `U` (URI) —
 * which covers essentially everything a desk reader writes to an NTAG. Records
 * of other types decode into {@link UnknownRecord} with their payload as hex so
 * nothing is silently dropped.
 *
 * The reader speaks NDEF as plain uppercase hex strings (`AT+RDNDEF` /
 * `AT+WRTNDEF=<hex>`), so hex — not `Uint8Array` — is this module's interchange
 * format.
 *
 * @module
 */

/** An NFC Forum Text record (`T`), RTD-Text. */
export interface TextRecord {
  kind: 'text';
  /** IANA language code, e.g. `en`, `de`. Encoded as UTF-8, ≤ 63 bytes. */
  lang: string;
  /** The text payload, encoded as UTF-8. */
  text: string;
}

/** An NFC Forum URI record (`U`), RTD-URI. */
export interface UriRecord {
  kind: 'uri';
  /** Full URI. Common prefixes are abbreviated automatically when encoding. */
  uri: string;
}

/** Any record this codec does not model; preserved so it can still be shown. */
export interface UnknownRecord {
  kind: 'unknown';
  /** Type Name Format (the low 3 bits of the record header). */
  tnf: number;
  /** The raw record type field, decoded as text (e.g. `Sp`, `application/json`). */
  recordType: string;
  /** The record payload as a lowercase hex string. */
  payloadHex: string;
}

/** A decoded NDEF record. Only `text` and `uri` can be encoded. */
export type NdefRecord = TextRecord | UriRecord | UnknownRecord;

// --- hex <-> bytes helpers -------------------------------------------------

/** Convert bytes to a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse a hex string (whitespace tolerated, case-insensitive) into bytes.
 *
 * @throws {Error} if the string has an odd number of hex digits.
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/\s+/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error(`Odd-length hex string: ${hex}`);
  }
  if (/[^0-9a-f]/i.test(clean)) {
    throw new Error(`Not a hex string: ${hex}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// --- NFC Forum URI abbreviation table (RTD-URI) ----------------------------

/**
 * The RTD-URI prefix abbreviation table. The index is the identifier code
 * stored as the first payload byte of a URI record.
 */
const URI_PREFIXES: readonly string[] = [
  '', // 0x00 — no abbreviation
  'http://www.',
  'https://www.',
  'http://',
  'https://',
  'tel:',
  'mailto:',
  'ftp://anonymous:anonymous@',
  'ftp://ftp.',
  'ftps://',
  'sftp://',
  'smb://',
  'nfs://',
  'ftp://',
  'dav://',
  'news:',
  'telnet://',
  'imap:',
  'rtsp://',
  'urn:',
  'pop:',
  'sip:',
  'sips:',
  'tftp:',
  'btspp://',
  'btl2cap://',
  'btgoep://',
  'tcpobex://',
  'irdaobex://',
  'file://',
  'urn:epc:id:',
  'urn:epc:tag:',
  'urn:epc:pat:',
  'urn:epc:raw:',
  'urn:epc:',
  'urn:nfc:', // 0x23
];

/** Pick the longest matching abbreviation code for a URI (0 = none). */
function findUriPrefixCode(uri: string): number {
  let bestCode = 0;
  let bestLength = 0;
  for (let code = 1; code < URI_PREFIXES.length; code++) {
    const prefix = URI_PREFIXES[code];
    if (uri.startsWith(prefix) && prefix.length > bestLength) {
      bestCode = code;
      bestLength = prefix.length;
    }
  }
  return bestCode;
}

// --- record header flags ---------------------------------------------------

const FLAG_MB = 0x80; // message begin
const FLAG_ME = 0x40; // message end
const FLAG_SR = 0x10; // short record
const FLAG_IL = 0x08; // ID length present
const TNF_WELL_KNOWN = 0x01;

const TYPE_TEXT = 0x54; // 'T'
const TYPE_URI = 0x55; // 'U'

/**
 * Encode records into a single NDEF message as an uppercase hex string, ready
 * to hand to `AT+WRTNDEF` (or {@link DeskIdNfc.writeHex}).
 *
 * @param records One or more {@link TextRecord} / {@link UriRecord}.
 * @returns Uppercase hex, no separators.
 * @throws {Error} on an empty list, an {@link UnknownRecord}, or a payload > 255 bytes.
 *
 * @example
 * ```ts
 * encodeNdefMessage([{ kind: 'text', lang: 'en', text: 'moin' }]);
 * // 'D101075402656E6D6F696E'
 * ```
 */
export function encodeNdefMessage(records: readonly NdefRecord[]): string {
  if (records.length === 0) {
    throw new Error('Cannot encode an empty NDEF message');
  }
  const encoder = new TextEncoder();
  const bytes: number[] = [];

  records.forEach((record, index) => {
    let type: number;
    let payload: Uint8Array;

    if (record.kind === 'text') {
      const langBytes = encoder.encode(record.lang);
      if (langBytes.length > 0x3f) {
        throw new Error(`Language code too long: ${record.lang}`);
      }
      const textBytes = encoder.encode(record.text);
      payload = new Uint8Array(1 + langBytes.length + textBytes.length);
      payload[0] = langBytes.length; // UTF-8 (bit 7 clear) + language code length
      payload.set(langBytes, 1);
      payload.set(textBytes, 1 + langBytes.length);
      type = TYPE_TEXT;
    } else if (record.kind === 'uri') {
      const code = findUriPrefixCode(record.uri);
      const remainder = record.uri.slice(URI_PREFIXES[code].length);
      const remainderBytes = encoder.encode(remainder);
      payload = new Uint8Array(1 + remainderBytes.length);
      payload[0] = code;
      payload.set(remainderBytes, 1);
      type = TYPE_URI;
    } else {
      throw new Error(`Cannot encode a record of kind "${record.kind}"`);
    }

    if (payload.length > 0xff) {
      throw new Error(`Only short records are supported (payload is ${payload.length} > 255 bytes)`);
    }

    let flags = FLAG_SR | TNF_WELL_KNOWN;
    if (index === 0) flags |= FLAG_MB;
    if (index === records.length - 1) flags |= FLAG_ME;

    bytes.push(flags, 1 /* type length */, payload.length, type, ...payload);
  });

  return bytesToHex(new Uint8Array(bytes)).toUpperCase();
}

/**
 * Decode a hex-encoded NDEF message (as returned by `AT+RDNDEF`) into records.
 *
 * Stops at the record carrying the ME (message end) flag, so trailing padding
 * on the tag is ignored.
 *
 * @throws {Error} if the hex is malformed or a record runs past the end of the buffer.
 */
export function decodeNdefMessage(hex: string): NdefRecord[] {
  const bytes = hexToBytes(hex);
  const records: NdefRecord[] = [];
  const decoder = new TextDecoder();

  /** Read `count` bytes, failing loudly instead of yielding `undefined`. */
  let offset = 0;
  const take = (count: number): Uint8Array => {
    if (offset + count > bytes.length) {
      throw new Error(`Truncated NDEF message: need ${count} byte(s) at offset ${offset} of ${bytes.length}`);
    }
    const slice = bytes.slice(offset, offset + count);
    offset += count;
    return slice;
  };
  const takeByte = (): number => take(1)[0];

  while (offset < bytes.length) {
    const flags = takeByte();
    const shortRecord = (flags & FLAG_SR) !== 0;
    const hasId = (flags & FLAG_IL) !== 0;
    const tnf = flags & 0x07;

    const typeLength = takeByte();

    let payloadLength: number;
    if (shortRecord) {
      payloadLength = takeByte();
    } else {
      const [b0, b1, b2, b3] = take(4);
      payloadLength = b0 * 0x1000000 + (b1 << 16) + (b2 << 8) + b3;
    }

    const idLength = hasId ? takeByte() : 0;
    const type = take(typeLength);
    take(idLength); // the record ID is not surfaced, but must be skipped
    const payload = take(payloadLength);

    const isWellKnown = tnf === TNF_WELL_KNOWN && typeLength === 1;

    if (isWellKnown && type[0] === TYPE_TEXT) {
      const statusByte = payload[0] ?? 0;
      const langLength = statusByte & 0x3f;
      records.push({
        kind: 'text',
        lang: decoder.decode(payload.slice(1, 1 + langLength)),
        text: decoder.decode(payload.slice(1 + langLength)),
      });
    } else if (isWellKnown && type[0] === TYPE_URI) {
      const code = payload[0] ?? 0;
      const prefix = URI_PREFIXES[code] ?? '';
      records.push({ kind: 'uri', uri: prefix + decoder.decode(payload.slice(1)) });
    } else {
      records.push({
        kind: 'unknown',
        tnf,
        recordType: decoder.decode(type),
        payloadHex: bytesToHex(payload),
      });
    }

    if (flags & FLAG_ME) break;
  }

  return records;
}

/**
 * Render a record as a short human-readable string, for logs and UI.
 *
 * @example `ndefRecordToString({ kind: 'uri', uri: 'https://example.com' })` → `'https://example.com'`
 */
export function ndefRecordToString(record: NdefRecord): string {
  switch (record.kind) {
    case 'text':
      return record.text;
    case 'uri':
      return record.uri;
    default:
      return `<${record.recordType || `tnf ${record.tnf}`}: ${record.payloadHex}>`;
  }
}
