import type { Member } from "@oa/shared";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifyPat } from "../auth/pat.js";
import { readSession, sessionCookieName } from "../auth/session.js";
import type { Env } from "../env.js";
import { getUser } from "../services/users.js";
import { ApiError, appOrigin, toErrorResponse } from "./errors.js";

/** Hono Variables set by `session()`; use as `Hono<{ Bindings: Env; Variables: AppVariables }>`. */
export type AppVariables = {
  user: Member | null;
  /** PAT label when authenticated by Bearer token (agent attribution), else null. */
  tokenLabel: string | null;
  tokenId: string | null;
};
export type AppEnv = { Bindings: Env; Variables: AppVariables };

export const CONTENT_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

type SecurityOpts = { frameDeny?: boolean; csp?: string };

/** A copy of `res` with the standard security headers (headers may be immutable). */
export function withSecurityHeaders(
  res: Response,
  opts: SecurityOpts = {},
): Response {
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("X-Robots-Tag", "noindex, nofollow");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (opts.frameDeny) h.set("X-Frame-Options", "DENY");
  if (opts.csp) h.set("Content-Security-Policy", opts.csp);
  return out;
}

export const securityHeaders =
  (opts: SecurityOpts = {}): MiddlewareHandler =>
  async (c, next) => {
    await next();
    // Responses from fetch()/Response.redirect() have immutable headers: re-wrap.
    c.res = withSecurityHeaders(c.res, opts);
  };

const BEARER = /^\s*Bearer(?:\s+(.*?))?\s*$/i;

/**
 * Sets c.var.user (Member | null), tokenLabel, tokenId.
 * An `Authorization: Bearer …` header is authoritative: a valid PAT sets the
 * user, anything else yields null with no cookie fallback. Any other (or no)
 * Authorization header falls through to the session cookie (sessionCookieName). The user row is
 * loaded on every request, so deleted users resolve to null.
 */
export const session = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  c.set("user", null);
  c.set("tokenLabel", null);
  c.set("tokenId", null);
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
    }
  } else {
    const s = await readSession(c.env, getCookie(c, sessionCookieName(c.env)));
    if (s) c.set("user", await getUser(c.env, s.uid));
  }
  await next();
};

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
