const CHUNK = 16 * 1024;
let enc: TextEncoder | undefined;
let scratch: Uint8Array | undefined;

/**
 * UTF-8 byte length of `s` (as TextEncoder would encode it) > `limit`,
 * without encoding the whole string at once: a 2 MB encode allocated a 2 MB
 * buffer per parse (GC pressure on Workers). Exact: bounds first, then
 * encodeInto over ≤ 16K-unit slices into one 48 KB scratch buffer, never
 * splitting a surrogate pair.
 */
export function utf8Exceeds(s: string, limit: number): boolean {
  if (s.length > limit) return true; // ≥ 1 byte per UTF-16 unit
  if (s.length * 3 <= limit) return false; // ≤ 3 bytes per UTF-16 unit
  enc ??= new TextEncoder();
  scratch ??= new Uint8Array(CHUNK * 3);
  let bytes = 0;
  for (let i = 0; i < s.length; ) {
    let j = Math.min(i + CHUNK, s.length);
    const last = s.charCodeAt(j - 1);
    if (j < s.length && last >= 0xd800 && last <= 0xdbff) j--;
    bytes += enc.encodeInto(s.slice(i, j), scratch).written;
    if (bytes > limit) return true;
    i = j;
  }
  return false;
}
