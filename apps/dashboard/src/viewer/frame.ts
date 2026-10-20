/** Artifacts are untrusted: never add allow-same-origin or allow-top-navigation. */
export const SANDBOX =
  "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** Only http(s) URLs on another origin may be framed. */
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
