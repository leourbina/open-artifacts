/**
 * Per-load bridge nonce. The viewer shell loads each artifact frame at
 * `<contentUrl>#oa=<nonce>` (or `…#<fragment>&oa=<nonce>`), a fresh 22-character
 * base64url value per load, and accepts only messages that carry it. A page the
 * frame was renavigated to never saw the URL, so it can't drive the bridge.
 */

/** 16 random bytes, base64url without padding. */
export const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

/** `url` with `oa=<nonce>` added to its fragment (`#oa=` or `&oa=`). */
export function withShellNonce(url: string, nonce: string): string {
  const i = url.indexOf("#");
  if (i < 0) return `${url}#oa=${nonce}`;
  return i === url.length - 1 ? `${url}oa=${nonce}` : `${url}&oa=${nonce}`;
}

const KEY = "__oaShellNonce";
type NonceHost = { [KEY]?: { n: string | undefined } };

/**
 * Reads `oa` from location.hash once per document (the first caller wins; the
 * runtime is injected first), then removes it with history.replaceState, keeping
 * the path, query and any other fragment content. If replaceState throws (it can
 * in a sandbox), the hash is left as it is. Undefined when there is no nonce.
 */
export function shellNonce(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as NonceHost;
  const cached = w[KEY];
  if (cached) return cached.n;
  let n: string | undefined;
  try {
    const parts = location.hash.slice(1).split("&");
    // The shell appends: take the last match.
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i] as string;
      if (p.startsWith("oa=") && NONCE_RE.test(p.slice(3))) {
        n = p.slice(3);
        parts.splice(i, 1);
        const rest = parts.join("&");
        try {
          history.replaceState(
            history.state,
            "",
            location.pathname + location.search + (rest ? `#${rest}` : ""),
          );
        } catch {
          // Sandboxed: leave the hash.
        }
        break;
      }
    }
  } catch {
    n = undefined;
  }
  try {
    Object.defineProperty(w, KEY, { value: { n }, configurable: true });
  } catch {
    // Read again next time (the hash may already be stripped).
  }
  return n;
}
