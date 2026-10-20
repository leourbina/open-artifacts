/** Artifacts are untrusted: never add allow-same-origin or allow-top-navigation. */
export const SANDBOX =
  "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** Only http(s) URLs on another origin may be framed or linked as raw content. */
export const safeContentUrl = (u: string | null) => {
  if (!u) return null;
  try {
    const p = new URL(u);
    return (p.protocol === "https:" || p.protocol === "http:") &&
      p.origin !== location.origin
      ? u
      : null;
  } catch {
    return null;
  }
};

/** 16 random bytes as base64url: 22 characters, minted for every src assignment. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * `<url>#oa=<nonce>`, or `&oa=<nonce>` when the URL already has a fragment. The
 * fragment never goes to the server or into a Referer; the runtime reads it and
 * strips it, then signs every message with it.
 */
export const withNonce = (url: string, nonce: string) =>
  `${url}${url.includes("#") ? "&" : "#"}oa=${nonce}`;
