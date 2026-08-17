/**
 * Error type used by every operation in this package.
 *
 * The reader reports failures as an `ERROR` line preceded by a human-readable
 * cause in angle brackets (`+SEL: <Tag timeout>`). Those strings are genuinely
 * useful to end users, so they are surfaced verbatim as {@link ReaderError.message}.
 */

/** Why an operation failed. */
export type ReaderErrorCode =
  /** The reader answered `ERROR`; `message` is its `<cause>` string. */
  | 'device'
  /** No response arrived before the command timeout elapsed. */
  | 'timeout'
  /** The port went away (unplugged, or closed underneath us). */
  | 'disconnected'
  /** The call needs an open port and there isn't one. */
  | 'not-connected'
  /** The call needs a tag on the reader and none is present. */
  | 'no-tag'
  /** WebSerial is missing (non-Chromium browser, or a non-browser runtime). */
  | 'unsupported';

/** An error raised by the reader, the transport, or an argument check. */
export class ReaderError extends Error {
  override readonly name = 'ReaderError';

  /** Machine-readable reason; see {@link ReaderErrorCode}. */
  readonly code: ReaderErrorCode;

  /** The AT command that failed, when the failure is tied to one. */
  readonly command?: string;

  constructor(message: string, code: ReaderErrorCode, command?: string) {
    super(message);
    this.code = code;
    this.command = command;
  }
}

/**
 * Whether a failure means "the tag was moved away mid-operation" rather than
 * "the operation is impossible".
 *
 * This is by far the most common real-world failure, and deserves its own UX:
 * ask the user to hold the tag still and retry, instead of showing an error.
 * For writes it also implies the tag content may be partially written.
 *
 * @example
 * ```ts
 * try {
 *   await nfc.read();
 * } catch (err) {
 *   if (isTagRemovedError(err)) showHint('Keep the tag on the reader');
 *   else throw err;
 * }
 * ```
 */
export function isTagRemovedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /tag timeout|no tag|collision/i.test(error.message);
}
