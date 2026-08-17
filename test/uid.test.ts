import { describe, expect, test } from 'bun:test';
import { formatUid, reverseUid } from '../src/uid.js';

describe('reverseUid', () => {
  test('converts the reader byte order to the one phones show', () => {
    // Same physical NTAG213: reader says 901974A2429B04, a phone says 04:9B:42:A2:74:19:90.
    expect(reverseUid('901974A2429B04')).toBe('049B42A2741990');
    expect(formatUid(reverseUid('901974A2429B04'))).toBe('04:9B:42:A2:74:19:90');
  });

  test('is its own inverse', () => {
    expect(reverseUid(reverseUid('901974A2429B04'))).toBe('901974A2429B04');
  });

  test('ignores separators and case', () => {
    expect(reverseUid('04:9b:42:a2:74:19:90')).toBe('901974A2429B04');
  });

  test('rejects an odd number of hex digits', () => {
    expect(() => reverseUid('ABC')).toThrow(/odd-length/i);
  });
});

describe('formatUid', () => {
  test('groups bytes with a custom separator', () => {
    expect(formatUid('901974A2429B04', ' ')).toBe('90 19 74 A2 42 9B 04');
  });
});
