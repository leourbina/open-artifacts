import { inDomains } from "@oa/auth-core";
import {
  ARTIFACT_SANDBOX_ATTR,
  AUTH,
  type AuthMethod,
  type CapReason,
  type Member,
  SIGN_IN_PAGE,
} from "@oa/shared";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { authConfig } from "../auth/config.js";
import { verifyPat } from "../auth/pat.js";
import {
  readSession,
  type Session,
  sessionCookieName,
} from "../auth/session.js";
import type { Env } from "../env.js";
import { getUser, getUserWithEpoch } from "../services/users.js";
import { frameOpts, isEmbedRequest } from "./embed.js";
import { ApiError, appOrigin, toErrorResponse } from "./errors.js";

/** Hono Variables set by `session()`; use as `Hono<{ Bindings: Env; Variables: AppVariables }>`. */
export type AppVariables = {
  user: Member | null;
  /** PAT label when authenticated by Bearer token (agent attribution), else null. */
  tokenLabel: string | null;
  tokenId: string | null;
  /** Set once the session has been read (the policy gate may read it first). */
  sessionResolved?: boolean;
  /** How this request authenticated (Me.auth.method); null when anonymous. */
  authMethod: AuthMethod | null;
  /** Session expiry (ms) for a cookie session; null otherwise. */
  sessionExp: number | null;
  /**
   * Why the caller is capped at viewer (Me.auth.cap), or null: "guest" for a
   * guest while the guest cap is on, and for any code session outside the
   * verified domains. P3 adds "restricted".
   */
  capReason: CapReason | null;
};
export type AppEnv = { Bindings: Env; Variables: AppVariables };

export const CONTENT_CSP = `sandbox ${ARTIFACT_SANDBOX_ATTR}`;

/**
 * Sign-in pages a client may open in a popup (web MCP connectors run OAuth in
 * one and read the result through window.opener): no COOP there, or the
 * popup loses its opener. Exact pathnames only, never prefixes.
 */
export const COOP_EXEMPT: ReadonlySet<string> = new Set([
  "/oauth/authorize", // GET consent page, POST consent decision
  "/auth/login",
  "/auth/callback",
  "/auth/dev-login",
  SIGN_IN_PAGE,
  AUTH.loginGoogle,
  AUTH.callbackGoogle,
]);

/**
 * OAuth/OIDC callbacks: their URL carries a code and state, so the page they
 * land on (or an error page) must not send it on as a Referer.
 * Exact pathnames only.
 */
export const NO_REFERRER: ReadonlySet<string> = new Set([
  AUTH.callback,
  AUTH.callbackGoogle,
]);

/**
 * `frameAncestors` (a pre-validated source list from frameOpts) replaces
 * X-Frame-Options with `Content-Security-Policy: frame-ancestors …` (merged
 * into `csp`, when given, as one header); it wins over `frameDeny`.
 */
type SecurityOpts = {
  frameDeny?: boolean;
  frameAncestors?: string;
  csp?: string;
  /** Cross-Origin-Opener-Policy: same-origin (app host only; see appHostOpts). */
  coop?: boolean;
  /** Referrer-Policy: no-referrer instead of strict-origin-when-cross-origin. */
  noReferrer?: boolean;
};

/**
 * App-host security options for a request: framing per frameOpts, plus
 * `Cross-Origin-Opener-Policy: same-origin` (a popup opened from an artifact
 * can't reach back into our pages) except on COOP_EXEMPT. Never on the
 * content host.
 */
export const appHostOpts = (
  env: Env,
  method: string,
  pathname: string,
): SecurityOpts => ({
  ...frameOpts(env, method, pathname),
  coop: !COOP_EXEMPT.has(pathname),
  noReferrer: NO_REFERRER.has(pathname),
});

/** `res` with the standard security headers; a copy when its headers are immutable. */
export function withSecurityHeaders(
  res: Response,
  opts: SecurityOpts = {},
): Response {
  if (res.status === 101) return res;
  // Most responses (c.json, new Response) have mutable headers: set them in
  // place. Immutable ones (fetch(), Response.redirect()) throw on the first
  // set, before any change, and are re-wrapped.
  try {
    setSecurityHeaders(res.headers, opts);
    return res;
  } catch {
    const out = new Response(res.body, res);
    setSecurityHeaders(out.headers, opts);
    return out;
  }
}

function setSecurityHeaders(h: Headers, opts: SecurityOpts): void {
  h.set("X-Robots-Tag", "noindex, nofollow");
  h.set("X-Content-Type-Options", "nosniff");
  h.set(
    "Referrer-Policy",
    opts.noReferrer ? "no-referrer" : "strict-origin-when-cross-origin",
  );
  if (opts.coop) h.set("Cross-Origin-Opener-Policy", "same-origin");
  else h.delete("Cross-Origin-Opener-Policy");
  if (opts.frameAncestors) {
    h.delete("X-Frame-Options");
    const fa = `frame-ancestors ${opts.frameAncestors}`;
    h.set("Content-Security-Policy", opts.csp ? `${opts.csp}; ${fa}` : fa);
  } else {
    if (opts.frameDeny) h.set("X-Frame-Options", "DENY");
    if (opts.csp) h.set("Content-Security-Policy", opts.csp);
  }
}

/** App-host security headers; framing per frameOpts (DENY except /a/:id/full with EMBED_ORIGINS). */
export const securityHeaders =
  (): MiddlewareHandler<AppEnv> => async (c, next) => {
    await next();
    // Responses from fetch()/Response.redirect() have immutable headers: re-wrap.
    c.res = withSecurityHeaders(
      c.res,
      appHostOpts(c.env, c.req.method, new URL(c.req.url).pathname),
    );
  };

const BEARER = /^\s*Bearer(?:\s+(.*?))?\s*$/i;

/**
 * A signed session is still good for this user and install: its epoch is the
 * user's current one (a bump ends every session), its tenant, if any, is
 * still a verified domain, and a domain-code session ends once Google is on.
 */
export function sessionStillValid(
  env: Env,
  s: Session,
  sessionEpoch: number,
): boolean {
  if ((s.e ?? 0) !== sessionEpoch) return false;
  if (s.t === undefined) return true;
  const cfg = authConfig(env);
  if (!inDomains(cfg.domains, s.t)) return false;
  return !(s.p === "code" && cfg.providers.has("google"));
}

/**
 * Sets c.var.user (Member | null), tokenLabel, tokenId, authMethod, sessionExp.
 * An `Authorization: Bearer …` header is authoritative: a valid PAT sets the
 * user, anything else yields null with no cookie fallback. Any other (or no)
 * Authorization header falls through to the session cookie (sessionCookieName). The user row is
 * loaded on every request, so deleted users resolve to null, and a cookie
 * session must pass sessionStillValid.
 * `X-OA-Embed: 1` or `?embed=1` (isEmbedRequest) forces anonymous.
 */
export const session = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await resolveSession(c);
  await next();
};

/** Reads the session once per request (idempotent); see `session()`. */
export async function resolveSession(c: Context<AppEnv>): Promise<void> {
  if (c.get("sessionResolved")) return;
  c.set("sessionResolved", true);
  c.set("user", null);
  c.set("tokenLabel", null);
  c.set("tokenId", null);
  c.set("authMethod", null);
  c.set("sessionExp", null);
  c.set("capReason", null);
  // Embed mode: anonymous regardless of cookie or Bearer (a downgrade only).
  if (isEmbedRequest(c.req.raw)) return;
  const bearer = BEARER.exec(c.req.header("authorization") ?? "");
  if (bearer) {
    let ctx: Pick<ExecutionContext, "waitUntil"> | undefined;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = undefined;
    }
    const pat = await verifyPat(c.env, bearer[1] ?? "", ctx);
    const user = pat ? await getUser(c.env, pat.userId) : null;
    if (pat && user) {
      c.set("user", user);
      c.set("tokenLabel", pat.label);
      c.set("tokenId", pat.tokenId);
      c.set("authMethod", "pat");
    }
  } else {
    const s = await readSession(c.env, getCookie(c, sessionCookieName(c.env)));
    const row = s ? await getUserWithEpoch(c.env, s.uid) : null;
    if (s && row && sessionStillValid(c.env, s, row.sessionEpoch)) {
      c.set("user", row.user);
      c.set("authMethod", s.p);
      c.set("sessionExp", s.exp);
      if (
        (s.p === "code" && s.t === undefined) ||
        (row.user.role === "guest" && authConfig(c.env).guestsReadOnly)
      )
        c.set("capReason", "guest");
    }
  }
}

export const CSRF_HEADER = "X-OA-Request";

/**
 * Mutating requests (anything but GET/HEAD) that authenticate by session cookie
 * (no `Authorization: Bearer`, and a sessionCookieName(env) cookie present) must send
 * `X-OA-Request: 1`, else 403 csrf. Bearer/PAT requests are exempt. Mount on
 * `/api/v1/*` and `/auth/logout`.
 */
export const csrf = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD") {
    const bearer = BEARER.test(c.req.header("authorization") ?? "");
    const cookie = getCookie(c, sessionCookieName(c.env)) !== undefined;
    if (!bearer && cookie && c.req.header(CSRF_HEADER) !== "1")
      return toErrorResponse(
        new ApiError("csrf", `Missing ${CSRF_HEADER}: 1 header`),
      );
  }
  await next();
};

/**
 * Rejects cross-site requests (403 csrf): `Sec-Fetch-Site: cross-site`, or an
 * `Origin` header that differs from the app origin. Used for POST /auth/logout,
 * which must not be triggerable by another site.
 */
export const sameOrigin = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const site = c.req.header("sec-fetch-site");
  const origin = c.req.header("origin");
  if (
    site === "cross-site" ||
    (origin !== undefined && origin !== appOrigin(c.env))
  )
    return toErrorResponse(new ApiError("csrf", "Cross-site request"));
  await next();
};

/** c.executionCtx, or undefined where there is none (direct app.fetch in tests). */
export const execCtx = (c: Context<AppEnv>) => {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
};
