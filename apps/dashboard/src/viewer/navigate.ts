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

/** True at most once per NAV_INTERVAL_MS: navigate and open share one. */
export function createLimiter(now: () => number = Date.now) {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < NAV_INTERVAL_MS) return false;
    last = t;
    return true;
  };
}

const newTab = (u: string) => void window.open(u, "_blank", "noopener");

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
    limit?: () => boolean;
    embed?: () => boolean;
    open?: (url: string) => void;
  } = {},
) {
  const limit = opts.limit ?? createLimiter(opts.now);
  const embed = opts.embed ?? isEmbed;
  const open = opts.open ?? newTab;
  return (url: string) => {
    const origin = opts.origin ?? location.origin;
    const path = artifactNavPath(url, origin);
    if (!path || !limit()) return;
    if (embed()) open(origin + path);
    else go(path);
  };
}

/** A web address the shell may open for an artifact: http(s), no credentials. */
export function openableUrl(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  return u;
}

const HOST_MAX = 32;

/** The host to name in a prompt: ASCII (punycode as is), no "www.", cut from the left. */
export function linkHost(u: URL): string {
  const h = u.hostname.replace(/^www\./, "");
  return h.length > HOST_MAX ? `…${h.slice(-(HOST_MAX - 1))}` : h;
}

/** Transient user activation in this window (a click in the frame counts). */
const userActive = () =>
  (navigator as Navigator & { userActivation?: { isActive: boolean } })
    .userActivation?.isActive === true;

/**
 * Builds the shell's open handler: an artifact asked to open a plain link that
 * the sandboxed frame can't show. The message is content-controlled, so the
 * URL must be http(s) without credentials, the rate limit applies, and the top
 * window moves only with transient user activation; without it, `ask` puts the
 * choice in the shell's chrome. App viewer links route in place, like navigate;
 * embedded, everything opens in a new tab.
 */
export function createOpener(opts: {
  go: (path: string) => void;
  ask: (u: URL, open: () => void) => void;
  limit: () => boolean;
  origin?: string;
  embed?: () => boolean;
  active?: () => boolean;
  assign?: (url: string) => void;
  open?: (url: string) => void;
}) {
  const embed = opts.embed ?? isEmbed;
  const active = opts.active ?? userActive;
  const assign = opts.assign ?? ((u: string) => location.assign(u));
  const open = opts.open ?? newTab;
  return (url: string) => {
    const origin = opts.origin ?? location.origin;
    const u = openableUrl(url);
    if (!u || !opts.limit()) return;
    const path = artifactNavPath(u.href, origin);
    if (embed()) open(path ? origin + path : u.href);
    else if (path) opts.go(path);
    else if (active()) assign(u.href);
    else opts.ask(u, () => assign(u.href));
  };
}
