import { NAVIGATE_PATH_RE } from "@oa/shared";
import { isEmbed } from "../embed";

/**
 * An artifact asked the shell to navigate (a plain link to this app clicked
 * inside the frame). The message is content-controlled, so only a same-origin
 * artifact view path passes: no credentials, and any query or hash is dropped.
 * Returns the path to go to, or null to ignore the request.
 */
export function artifactNavPath(
  url: string,
  origin: string = location.origin,
): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== origin || u.username || u.password) return null;
  return NAVIGATE_PATH_RE.test(u.pathname) ? u.pathname : null;
}

export const NAV_INTERVAL_MS = 1_000;

/**
 * Builds the shell's navigate handler: validates the URL, ignores a second
 * request within NAV_INTERVAL_MS, and in embed mode opens a new tab instead of
 * moving this (framed) window.
 */
export function createNavigator(
  go: (path: string) => void,
  opts: {
    origin?: string;
    now?: () => number;
    embed?: () => boolean;
    open?: (url: string) => void;
  } = {},
) {
  const now = opts.now ?? Date.now;
  const embed = opts.embed ?? isEmbed;
  const open =
    opts.open ?? ((u: string) => void window.open(u, "_blank", "noopener"));
  let last = -Infinity;
  return (url: string) => {
    const origin = opts.origin ?? location.origin;
    const path = artifactNavPath(url, origin);
    if (!path) return;
    const t = now();
    if (t - last < NAV_INTERVAL_MS) return;
    last = t;
    if (embed()) open(origin + path);
    else go(path);
  };
}
