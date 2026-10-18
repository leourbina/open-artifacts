import { LIMITS } from "./limits.js";

export type PathError =
  | "empty"
  | "absolute"
  | "traversal"
  | "backslash"
  | "control_char"
  | "too_long"
  | "empty_segment";

function isForbiddenChar(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x200e ||
    c === 0x200f ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
}

/** `%2e` / `%2f` (any case): percent-encoded "." or "/". */
const ENCODED_DOT_SLASH = /%2[ef]/i;

export function normalizePath(
  p: string,
): { ok: true; path: string } | { ok: false; error: PathError } {
  const fail = (error: PathError) => ({ ok: false as const, error });
  if (p.length === 0) return fail("empty");
  p = p.normalize("NFC");
  for (let i = 0; i < p.length; i++) {
    if (isForbiddenChar(p.charCodeAt(i))) return fail("control_char");
  }
  if (p.includes("\\")) return fail("backslash");
  if (p.length > LIMITS.pathMaxChars) return fail("too_long");
  if (p.startsWith("/")) return fail("absolute");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    // An encoded "." or "/" would decode into traversal on a later decode.
    if (seg === ".." || ENCODED_DOT_SLASH.test(seg)) return fail("traversal");
    if (seg === "") return fail("empty_segment");
    if (seg === ".") continue;
    out.push(seg);
  }
  if (out.length === 0) return fail("empty");
  return { ok: true, path: out.join("/") };
}

export function findCaseCollision(paths: string[]): [string, string] | null {
  const seen = new Map<string, string>();
  for (const p of paths) {
    const key = p.normalize("NFC").toUpperCase().toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined && prev !== p) return [prev, p];
    seen.set(key, p);
  }
  return null;
}
