import { createHash } from "node:crypto";

/**
 * Longest slug before it is truncated and hashed.
 * TODO: switch to `secretFile` from @oa/shared once it lands; the limit here is
 * an assumption until then (test/pat-file.test.ts pins the vectors).
 */
const MAX_SLUG = 48;

/** The app host as a file-name slug: lowercase, dots (and anything odd) to `-`; long ones are cut and get a 6-character hash. */
export function hostSlug(host: string): string {
  const h = host.trim().toLowerCase();
  const slug = h.replace(/[^a-z0-9-]/g, "-");
  if (slug.length <= MAX_SLUG) return slug;
  const hash = createHash("sha256").update(h).digest("hex").slice(0, 6);
  return `${slug.slice(0, MAX_SLUG - 7)}-${hash}`;
}

/** The PAT file for an app host, under `home`. */
export const patTokenFile = (home: string, appHost: string): string =>
  `${home}/.open-artifacts/${hostSlug(appHost)}-pat-token`;

/** Same file, with `~` for the home directory (what a snippet shows). */
export const patTokenFileTilde = (appHost: string): string =>
  `~/.open-artifacts/${hostSlug(appHost)}-pat-token`;
