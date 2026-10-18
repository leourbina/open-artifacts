/**
 * Shared UTF-8 codecs, one per isolate (the hot paths built one per call).
 * decode() is only ever called without `stream`, so it keeps no state.
 */
export const utf8Encoder = new TextEncoder();
export const utf8Decoder = new TextDecoder();

const SLICE = 16 * 1024;
let scratch: Uint8Array | undefined;

/**
 * UTF-8 byte length of a well-formed string (no lone surrogates), without
 * allocating its encoding: encodeInto over ≤ 16K-unit slices into one 48 KB
 * scratch buffer, never splitting a surrogate pair.
 */
export function utf8Length(s: string): number {
  scratch ??= new Uint8Array(SLICE * 3);
  let n = 0;
  for (let i = 0; i < s.length; ) {
    let j = Math.min(i + SLICE, s.length);
    const last = s.charCodeAt(j - 1);
    if (j < s.length && last >= 0xd800 && last <= 0xdbff) j--;
    n += utf8Encoder.encodeInto(s.slice(i, j), scratch).written;
    i = j;
  }
  return n;
}

/** String.prototype.isWellFormed (ES2024): no lone surrogates. */
export const isWellFormed = (s: string): boolean =>
  (s as unknown as { isWellFormed(): boolean }).isWellFormed();
