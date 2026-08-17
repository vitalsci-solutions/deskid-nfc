import { describe, expect, test } from 'bun:test';
import {
  bytesToHex,
  decodeNdefMessage,
  encodeNdefMessage,
  hexToBytes,
  ndefRecordToString,
  type NdefRecord,
} from '../src/ndef.js';

describe('hex helpers', () => {
  test('round-trips bytes through hex', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xab]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  test('tolerates whitespace and mixed case', () => {
    expect(hexToBytes(' D1 01 aB ')).toEqual(new Uint8Array([0xd1, 0x01, 0xab]));
  });

  test('rejects odd-length and non-hex input', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd-length/i);
    expect(() => hexToBytes('zz')).toThrow(/not a hex string/i);
  });
});

describe('text records', () => {
  test('matches the message written to real hardware', () => {
    // The exact payload of the first successful AT+WRTNDEF on the device.
    expect(encodeNdefMessage([{ kind: 'text', lang: 'en', text: 'moin' }])).toBe('D101075402656E6D6F696E');
  });

  test('encodes then decodes a simple text record', () => {
    const hex = encodeNdefMessage([{ kind: 'text', lang: 'en', text: 'hello world' }]);
    expect(decodeNdefMessage(hex)).toEqual([{ kind: 'text', lang: 'en', text: 'hello world' }]);
  });

  test('handles non-ASCII UTF-8 text', () => {
    const hex = encodeNdefMessage([{ kind: 'text', lang: 'de', text: 'grüße' }]);
    expect(decodeNdefMessage(hex)).toEqual([{ kind: 'text', lang: 'de', text: 'grüße' }]);
  });

  test('sets MB/ME/SR/TNF header flags for a single record', () => {
    const hex = encodeNdefMessage([{ kind: 'text', lang: 'en', text: 'x' }]);
    // MB(0x80) | ME(0x40) | SR(0x10) | TNF=0x01 (well-known) = 0xD1
    expect(parseInt(hex.substring(0, 2), 16)).toBe(0xd1);
  });
});

describe('uri records', () => {
  test('encodes then decodes using the https://www. abbreviation', () => {
    const hex = encodeNdefMessage([{ kind: 'uri', uri: 'https://www.example.com' }]);
    expect(decodeNdefMessage(hex)).toEqual([{ kind: 'uri', uri: 'https://www.example.com' }]);
  });

  test('uses the longest matching prefix (https:// over https://www.)', () => {
    const bytes = hexToBytes(encodeNdefMessage([{ kind: 'uri', uri: 'https://example.com' }]));
    expect(bytes[4]).toBe(0x04); // payload[0] is the prefix code: 'https://'
  });

  test('falls back to code 0x00 for unabbreviated schemes', () => {
    const hex = encodeNdefMessage([{ kind: 'uri', uri: 'custom-scheme://thing' }]);
    expect(hexToBytes(hex)[4]).toBe(0x00);
    expect(decodeNdefMessage(hex)).toEqual([{ kind: 'uri', uri: 'custom-scheme://thing' }]);
  });

  test('round-trips mailto: and tel: prefixes', () => {
    for (const uri of ['mailto:someone@example.com', 'tel:+491234567']) {
      expect(decodeNdefMessage(encodeNdefMessage([{ kind: 'uri', uri }]))).toEqual([{ kind: 'uri', uri }]);
    }
  });
});

describe('multi-record messages', () => {
  test('round-trips two records with correct MB/ME placement', () => {
    const records: NdefRecord[] = [
      { kind: 'text', lang: 'en', text: 'first' },
      { kind: 'uri', uri: 'https://example.com' },
    ];
    const hex = encodeNdefMessage(records);
    const bytes = hexToBytes(hex);
    expect(bytes[0] & 0xc0).toBe(0x80); // first record: MB set, ME clear
    expect(decodeNdefMessage(hex)).toEqual(records);
  });

  test('ignores trailing bytes after the message-end record', () => {
    const hex = encodeNdefMessage([{ kind: 'text', lang: 'en', text: 'a' }]) + 'FFFFFF';
    expect(decodeNdefMessage(hex)).toEqual([{ kind: 'text', lang: 'en', text: 'a' }]);
  });
});

describe('unknown records', () => {
  test('decodes an unrecognized type as unknown, keeping the payload', () => {
    // header(MB|ME|SR|TNF=1), type_len=1, payload_len=2, type='X', payload=0xBEEF
    expect(decodeNdefMessage('D1010258BEEF')).toEqual([
      { kind: 'unknown', tnf: 1, recordType: 'X', payloadHex: 'beef' },
    ]);
  });

  test('decodes a long (non-short) record', () => {
    // flags=0xC0 (MB|ME, SR clear), type_len=1, payload_len=0x00000002, type='X', payload
    expect(decodeNdefMessage('C00100000002' + '58' + 'BEEF')).toEqual([
      { kind: 'unknown', tnf: 0, recordType: 'X', payloadHex: 'beef' },
    ]);
  });
});

describe('failure modes', () => {
  test('throws on an empty record list', () => {
    expect(() => encodeNdefMessage([])).toThrow(/empty/i);
  });

  test('refuses to encode an unknown record', () => {
    expect(() => encodeNdefMessage([{ kind: 'unknown', tnf: 1, recordType: 'X', payloadHex: 'beef' }])).toThrow(
      /kind "unknown"/,
    );
  });

  test('refuses payloads that do not fit a short record', () => {
    expect(() => encodeNdefMessage([{ kind: 'text', lang: 'en', text: 'x'.repeat(256) }])).toThrow(/short records/i);
  });

  test('throws on a truncated message instead of inventing records', () => {
    // says payload_len=7 but only 2 payload bytes follow
    expect(() => decodeNdefMessage('D1010754026E')).toThrow(/truncated/i);
  });
});

describe('ndefRecordToString', () => {
  test('renders each record kind', () => {
    expect(ndefRecordToString({ kind: 'text', lang: 'en', text: 'hi' })).toBe('hi');
    expect(ndefRecordToString({ kind: 'uri', uri: 'https://x.test' })).toBe('https://x.test');
    expect(ndefRecordToString({ kind: 'unknown', tnf: 1, recordType: 'X', payloadHex: 'beef' })).toBe('<X: beef>');
  });
});
