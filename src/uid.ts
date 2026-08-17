/**
 * UID formatting helpers.
 *
 * The reader reports UIDs in the opposite byte order from what phones and NXP
 * tooling show: the reader's `901974A2429B04` is the same tag a phone displays
 * as `04:9B:42:A2:74:19:90`. Always feed the reader's own byte order back into
 * `AT+SEL`; convert only for display and interop.
 *
 * @module
 */

/**
 * Reverse the byte order of a hex UID.
 *
 * @param uid Hex UID, with or without separators.
 * @returns The reversed uppercase hex UID, without separators.
 * @throws {Error} if the input has an odd number of hex digits.
 *
 * @example
 * ```ts
 * reverseUid('901974A2429B04'); // '049B42A2741990' — what a phone shows
 * ```
 */
export function reverseUid(uid: string): string {
  const clean = uid.replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2 !== 0) throw new Error(`Odd-length UID: ${uid}`);
  const bytes = clean.match(/../g) ?? [];
  return bytes.reverse().join('').toUpperCase();
}

/**
 * Group a hex UID into colon-separated bytes for display.
 *
 * @example
 * ```ts
 * formatUid(reverseUid('901974A2429B04')); // '04:9B:42:A2:74:19:90'
 * ```
 */
export function formatUid(uid: string, separator = ':'): string {
  const clean = uid.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return (clean.match(/../g) ?? []).join(separator);
}
