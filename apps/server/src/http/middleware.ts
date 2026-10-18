import type { Member } from "@oa/shared";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifyPat } from "../auth/pat.js";
import { readSession } from "../auth/session.js";
import type { Env } from "../env.js";
import { getUser } from "../services/users.js";

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

export const securityHeaders =
  (opts: { frameDeny?: boolean; csp?: string } = {}): MiddlewareHandler =>
  async (c, next) => {
    await next();
    // Responses from fetch()/Response.redirect() have immutable headers: re-wrap.
    c.res = new Response(c.res.body, c.res);
    const h = c.res.headers;
    h.set("X-Robots-Tag", "noindex, nofollow");
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "strict-origin-when-cross-origin");
    if (opts.frameDeny) h.set("X-Frame-Options", "DENY");
    if (opts.csp) h.set("Content-Security-Policy", opts.csp);
  };

const BEARER = /^\s*Bearer(?:\s+(.*?))?\s*$/i;

/**
 * Sets c.var.user (Member | null), tokenLabel, tokenId.
 * An `Authorization: Bearer …` header is authoritative: a valid PAT sets the
 * user, anything else yields null with no cookie fallback. Any other (or no)
 * Authorization header falls through to the oa_session cookie. The user row is
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
    const s = await readSession(c.env, getCookie(c, "oa_session"));
    if (s) c.set("user", await getUser(c.env, s.uid));
  }
  await next();
};
