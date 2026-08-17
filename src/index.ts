/**
 * `deskid-nfc` — talk to a Metratec DeskID NFC desk reader from the browser
 * over WebSerial: tag presence events, NDEF read/write, no dependencies.
 *
 * @example
 * ```ts
 * import { DeskIdNfc, ndefRecordToString } from 'deskid-nfc';
 *
 * const nfc = new DeskIdNfc();
 * nfc.on('tag', async (tag) => {
 *   const { records } = await nfc.read(tag.uid);
 *   console.log(tag.uid, records.map(ndefRecordToString));
 * });
 *
 * connectButton.addEventListener('click', () => nfc.open());
 * ```
 *
 * @module
 */

export { DeskIdNfc } from './reader.js';
export type {
  CloseReason,
  DeskIdNfcEvents,
  DeskIdNfcOptions,
  NdefReadResult,
  NdefState,
  ReaderInfo,
  Tag,
} from './reader.js';

export { ReaderError, isTagRemovedError } from './errors.js';
export type { ReaderErrorCode } from './errors.js';

export {
  bytesToHex,
  decodeNdefMessage,
  encodeNdefMessage,
  hexToBytes,
  ndefRecordToString,
} from './ndef.js';
export type { NdefRecord, TextRecord, UnknownRecord, UriRecord } from './ndef.js';

export { formatUid, reverseUid } from './uid.js';

export { SerialTransport, isWebSerialSupported, requestSerialPort } from './transport.js';
export type {
  LogDirection,
  LogEntry,
  SerialPortInfoLike,
  SerialPortLike,
  TransportOptions,
} from './transport.js';

export { Emitter } from './emitter.js';
export type { EventMap, Listener } from './emitter.js';
