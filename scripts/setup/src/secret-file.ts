import { homedir } from "node:os";

/**
 * The app host as a file-name slug: lowercase, every run of other characters
 * to `-`, no leading or trailing `-`. The input is APP_HOST without a scheme,
 * keeping any port.
 * TODO: import `secretFile` from @oa/shared once it lands (same rule, pinned
 * by test/pat-file.test.ts).
 */
export const hostSlug = (host: string): string =>
  host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "instance";

/** HOME from the env; an unset or empty one falls back to the OS home directory. */
export const homeOf = (env: Record<string, string | undefined>): string =>
  env.HOME?.trim() || homedir();

/** The PAT file for an app host, as an absolute path under `home`. */
export const patTokenFile = (home: string, appHost: string): string =>
  `${home}/.open-artifacts/${hostSlug(appHost)}-pat-token`;
