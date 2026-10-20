import type { InstallId } from "./types.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_RE = /^i[a-z0-9]{11}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const RESERVED_SLUGS: readonly string[] = [
  "www",
  "api",
  "admin",
  "app",
  "mail",
  "status",
  "docs",
  "staging",
  "content",
];

export function isInstallId(s: string): s is InstallId {
  return ID_RE.test(s);
}

/** "i" + 11 base32 chars; a 5-bit mask over random bytes, so no modulo bias. */
export function newInstallId(): InstallId {
  const bytes = crypto.getRandomValues(new Uint8Array(11));
  let out = "i";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

export function names(id: InstallId): {
  script: string;
  d1: string;
  r2: string;
  kv: string;
} {
  return {
    script: `oa-${id}`,
    d1: `oa-${id}`,
    r2: `oa-${id}`,
    kv: `oa-${id}-oauth`,
  };
}

export function hosts(
  slug: string,
  domains: { app: string; content: string },
): { appHost: string; contentHost: string } {
  if (!SLUG_RE.test(slug) || RESERVED_SLUGS.includes(slug)) {
    throw new Error(`invalid slug: ${slug}`);
  }
  const { app, content } = domains;
  if (
    app === content ||
    app.endsWith(`.${content}`) ||
    content.endsWith(`.${app}`)
  ) {
    throw new Error("app and content domain must be distinct and not nested");
  }
  return { appHost: `${slug}.${app}`, contentHost: `${slug}.${content}` };
}
