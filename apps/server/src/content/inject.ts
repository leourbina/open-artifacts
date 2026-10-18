/**
 * Streaming byte-prefix injector (no per-node HTML parsing, O(1) per byte
 * after the prefix). Buffers at most PREFIX_MAX bytes, finds where the
 * runtime <script> must go so it runs before any artifact script, emits the
 * prefix + script, then pipes the rest of the body through untouched.
 */
const PREFIX_MAX = 64 * 1024;
/** Rescan at most every this many new bytes (bounds work on tiny chunks). */
const RESCAN_EVERY = 1024;
const BOM = "\xEF\xBB\xBF";
const enc = new TextEncoder();

type Spot = { at: number; wrap: boolean };

const isWs = (c: number) =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;

/** Index just past the tag's closing `>` (quote-aware), or -1. */
function tagEnd(s: string, j: number): number {
  for (let i = j; i < s.length; i++) {
    const ch = s[i];
    if (ch === ">") return i + 1;
    if (ch === '"' || ch === "'") {
      const k = s.indexOf(ch, i + 1);
      if (k < 0) return -1;
      i = k;
    }
  }
  return -1;
}

/**
 * Scans a latin1-decoded prefix. Skips a BOM, whitespace, comments, doctype
 * and `<html…>`; the first `<head…>` wins (insert after its `>`). Any other
 * tag or text means there is no head: insert a `<head>` wrapper after
 * `<html…>`, else after the doctype, else after the BOM (offset 0).
 * Returns null when more bytes are needed (only when !complete).
 */
export function findInsertion(s: string, complete: boolean): Spot | null {
  const start = s.startsWith(BOM) ? 3 : 0;
  let i = start;
  let htmlEnd = -1;
  let doctypeEnd = -1;
  const fallback = (): Spot => ({
    at: htmlEnd >= 0 ? htmlEnd : doctypeEnd >= 0 ? doctypeEnd : start,
    wrap: true,
  });
  const more = () => (complete ? fallback() : null);
  for (;;) {
    while (i < s.length && isWs(s.charCodeAt(i))) i++;
    if (i >= s.length) return more();
    if (s[i] !== "<") return fallback();
    if (i + 1 >= s.length) return more();
    const next = s[i + 1];
    if (next === "!" || next === "?") {
      if (s.length - i < 4) return more();
      if (s.startsWith("<!--", i)) {
        const e = s.indexOf("-->", i + 4);
        if (e < 0) return more();
        i = e + 3;
        continue;
      }
      const e = s.indexOf(">", i);
      if (e < 0) return more();
      if (s.slice(i, i + 9).toLowerCase() === "<!doctype") doctypeEnd = e + 1;
      i = e + 1;
      continue;
    }
    let j = i + 1;
    while (j < s.length && /[A-Za-z0-9]/.test(s[j] ?? "")) j++;
    if (j >= s.length) return more();
    const name = s.slice(i + 1, j).toLowerCase();
    const delim = s[j] ?? "";
    if (
      (name !== "head" && name !== "html") ||
      !(isWs(delim.charCodeAt(0)) || delim === ">" || delim === "/")
    )
      return fallback();
    const end = tagEnd(s, j);
    if (end < 0) return more();
    if (name === "head") return { at: end, wrap: false };
    htmlEnd = end;
    i = end;
  }
}

function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192)
    s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

/**
 * Injects `tag` (the runtime <script>) so it is the first thing in <head>.
 * `null` (no runtime bundle yet) returns `res` unchanged.
 */
export function injectRuntime(res: Response, tag: string | null): Response {
  if (tag === null) return res;
  const plain = enc.encode(tag);
  const wrapped = enc.encode(`<head>${tag}</head>`);
  const headers = new Headers(res.headers);
  headers.delete("Content-Length");
  const init = { status: res.status, statusText: res.statusText, headers };
  if (!res.body) return new Response(wrapped, init);
  const src = res.body;
  // Native identity stream: after the prefix, bytes are piped by the runtime
  // (no JS per chunk), so CPU stays flat however large the document is.
  const { readable, writable } = new IdentityTransformStream();
  void (async () => {
    const reader = src.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let text = "";
    let scanned = 0;
    let done = false;
    let spot: Spot | null = null;
    while (!spot) {
      const r = await reader.read();
      if (r.done) done = true;
      else {
        chunks.push(r.value);
        if (total < PREFIX_MAX)
          text += latin1(r.value.subarray(0, PREFIX_MAX - total));
        total += r.value.byteLength;
      }
      const complete = done || total >= PREFIX_MAX;
      if (complete || total - scanned >= RESCAN_EVERY) {
        scanned = total;
        spot = findInsertion(text, complete);
      }
    }
    reader.releaseLock();
    const ins = spot.wrap ? wrapped : plain;
    const buf = new Uint8Array(total + ins.length);
    let off = 0;
    for (const ch of chunks) {
      buf.set(ch, off);
      off += ch.byteLength;
    }
    // Shift the tail right and drop the script in at the insertion point.
    buf.copyWithin(spot.at + ins.length, spot.at, total);
    buf.set(ins, spot.at);
    const w = writable.getWriter();
    await w.write(buf);
    if (done) return w.close();
    w.releaseLock();
    await src.pipeTo(writable);
  })().catch((e) => writable.abort(e).catch(() => {}));
  return new Response(readable, init);
}
