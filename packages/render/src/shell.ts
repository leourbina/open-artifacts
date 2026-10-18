import { parseShellMessage, type ShellToArtifact } from "@oa/shared";

/** Subscribe to validated shell messages; anything not from window.parent is ignored. */
export function onShellMessage(
  handler: (msg: ShellToArtifact) => void,
): () => void {
  const listener = (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const msg = parseShellMessage(e.data);
    if (msg) handler(msg);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

/** Longest prefix of `s` whose UTF-8 encoding fits in `maxBytes` (never splits a character). */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (s.length * 3 <= maxBytes) return s;
  const { read } = new TextEncoder().encodeInto(s, new Uint8Array(maxBytes));
  return s.slice(0, read);
}

/** The artifact version from a `/v{n}/` path segment. */
export function versionFromPath(pathname: string): number | null {
  const m = /\/v(\d+)\//.exec(pathname);
  return m ? Number(m[1]) : null;
}
