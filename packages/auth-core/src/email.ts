// Printable ASCII only (no spaces/controls), exactly one "@", non-empty local and domain.
const ASCII_EMAIL = /^[!-?A-~]+@[!-?A-~]+$/;
const MAX_EMAIL_LEN = 320;

/**
 * True iff the trimmed input is a printable-ASCII address. Checked on the raw
 * (pre-lowercase) string, because toLowerCase() folds e.g. U+212A KELVIN SIGN
 * onto ASCII "k".
 */
export function isAsciiEmail(s: string): boolean {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.length <= MAX_EMAIL_LEN && ASCII_EMAIL.test(t);
}

/**
 * Canonical form for every email write and lookup: trimmed + lowercased
 * printable ASCII. Returns null for anything else (treat as invalid).
 */
export function normalizeEmail(s: string): string | null {
  if (!isAsciiEmail(s)) return null;
  const e = s.trim().toLowerCase();
  return isAsciiEmail(e) ? e : null;
}
