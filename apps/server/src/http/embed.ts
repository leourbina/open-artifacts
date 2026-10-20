import type { Env } from "../env.js";

/**
 * EMBED_ORIGINS: space-separated origins allowed to frame /a/:id/full (and,
 * since frame-ancestors checks every ancestor, the content host under it).
 * Each entry must be a bare `https://host[:port]` origin (`http://localhost`
 * or `*.localhost` only when ENVIRONMENT=dev): no path, query, userinfo,
 * wildcard or keyword. Invalid entries are dropped (logged once per value).
 * Only the re-serialized URL origin ever reaches a header, never raw input.
 *
 * A same-site embedder (sharing the app host's last two labels, a cheap
 * heuristic with no public-suffix list) would get SameSite=Lax cookies in
 * the frame; it is kept but warned about. Anonymous framing relies on the
 * client embed mode (credentials: "omit"), plus the server's signed-out
 * shell render for a framed /full.
 */
type EmbedEnv = Pick<Env, "EMBED_ORIGINS" | "ENVIRONMENT"> &
  Partial<Pick<Env, "APP_HOST">>;

// Strict shape before URL parsing: scheme, ASCII host, optional port; nothing else.
const ORIGIN_SHAPE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const MAX_ORIGINS = 32;

let memo: { key: string; origins: readonly string[] } | undefined;

function parseOne(entry: string, dev: boolean): string | null {
  if (!ORIGIN_SHAPE.test(entry)) return null;
  let u: URL;
  try {
    u = new URL(entry);
  } catch {
    return null;
  }
  if (u.origin === "null" || u.origin !== entry.toLowerCase()) return null;
  if (u.protocol === "https:") return u.origin;
  const local = u.hostname === "localhost" || u.hostname.endsWith(".localhost");
  return dev && u.protocol === "http:" && local ? u.origin : null;
}

/** Validated, de-duplicated embed origins; [] when unset or all invalid. */
export function embedOrigins(env: EmbedEnv): readonly string[] {
  const raw = env.EMBED_ORIGINS ?? "";
  const key = `${env.ENVIRONMENT}\n${env.APP_HOST ?? ""}\n${raw}`;
  if (memo?.key === key) return memo.origins;
  const dev = env.ENVIRONMENT === "dev";
  // Split on spaces/tabs only: a CR/LF stays inside its entry and fails the shape.
  const entries = raw.split(/[ \t]+/).filter(Boolean);
  const out: string[] = [];
  const dropped: string[] = [];
  for (const e of entries) {
    const o = parseOne(e, dev);
    if (o === null || out.length >= MAX_ORIGINS) dropped.push(e);
    else if (!out.includes(o)) out.push(o);
  }
  if (dropped.length)
    console.warn(
      `EMBED_ORIGINS: dropped ${dropped.length} invalid entr${dropped.length === 1 ? "y" : "ies"}`,
      JSON.stringify(dropped.map((d) => d.slice(0, 100)).slice(0, 10)),
    );
  const site = env.APP_HOST ? lastTwo(env.APP_HOST) : "";
  for (const o of out)
    if (site && lastTwo(new URL(o).hostname) === site)
      console.warn(
        `EMBED_ORIGINS: ${o} is same-site with the app host; framed sessions rely on the client embed mode`,
      );
  memo = { key, origins: out };
  return out;
}

const lastTwo = (host: string) =>
  host.toLowerCase().split(".").slice(-2).join(".");

const FULL_PATH = /^\/a\/[^/]+\/full$/;

/**
 * Framing policy for an app-host response: GET/HEAD /a/:id/full with valid
 * EMBED_ORIGINS gets `frame-ancestors 'self' <origins>`; everything else DENY.
 */
export function frameOpts(
  env: EmbedEnv,
  method: string,
  pathname: string,
): { frameDeny: true } | { frameAncestors: string } {
  if ((method === "GET" || method === "HEAD") && FULL_PATH.test(pathname)) {
    const o = embedOrigins(env);
    if (o.length) return { frameAncestors: `'self' ${o.join(" ")}` };
  }
  return { frameDeny: true };
}

/**
 * Content-host frame-ancestors: the app origin, plus the embed origins only on
 * a successful unsigned public (/p/) GET/HEAD; signed (private) content and
 * errors stay app-only.
 */
export function contentFrameAncestors(
  env: EmbedEnv,
  app: string,
  publicOk: boolean,
): string {
  const o = publicOk ? embedOrigins(env) : [];
  return o.length ? `${app} ${o.join(" ")}` : app;
}

/**
 * Embed-mode hint (#295): `X-OA-Embed: 1` (HTTP) or `?embed=1` (the
 * data-subscribe WebSocket, which can't set headers) drops the cookie/PAT
 * identity for that request. It is only a stricter hint: it can downgrade to
 * anonymous, never upgrade, so it needs no signature. It is NOT the guarantee
 * (an embedder's frame could omit it): the client embed mode uses
 * credentials: "omit", and a framed /full document always renders signed-out.
 */
export const EMBED_HEADER = "X-OA-Embed";
export const EMBED_PARAM = "embed";

export function isEmbedRequest(req: Request): boolean {
  if (req.headers.get(EMBED_HEADER) === "1") return true;
  return new URL(req.url).searchParams.get(EMBED_PARAM) === "1";
}

/** A /full shell fetched as a subresource (iframe, etc.), not a top-level page. */
export function isFramedFetch(req: Request): boolean {
  const dest = req.headers.get("sec-fetch-dest");
  return dest !== null && dest !== "document";
}
