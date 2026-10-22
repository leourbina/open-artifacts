import { AUTH, MemberSchema, PAGES, RoleSchema } from "@oa/shared";
import { authConfig } from "../auth/config.js";
import {
  buildAuthorizeRedirect,
  clearOidcCookie,
  handleCallback,
  logOidcFail,
  OidcStateError,
  pickStateCookie,
  safeNext,
} from "../auth/oidc.js";
import { accessProvider } from "../auth/providers/access.js";
import {
  clearSessionCookie,
  sessionCookie,
  signSession,
} from "../auth/session.js";
import { normEmail } from "../db/email.js";
import { ApiError, toErrorResponse } from "../http/errors.js";
import { FAVICON_TAGS } from "../http/head.js";
import {
  getUserWithEpoch,
  upsertOnLogin,
  upsertWithRole,
} from "../services/users.js";
import type { AppType } from "./index.js";

const redirect = (location: string, cookies: string[]) => {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
};

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ] as string,
  );

const RETRY_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Static page for a second state failure. Only user-derived content: escaped `next`. */
function retryPage(next: string, cookies: string[]): Response {
  const href = esc(`${AUTH.login}?next=${encodeURIComponent(next)}`);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in interrupted</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1a1a1a;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}a{color:#8ab4ff}}</style>
${FAVICON_TAGS}
</head><body><h1>Sign-in interrupted</h1>
<p>Sign-in took too long or was opened in another tab. Try again.</p>
<p><a href="${href}">Sign in again</a></p></body></html>`;
  const h = new Headers({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": RETRY_PAGE_CSP,
    "cache-control": "no-store",
  });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(html, { status: 400, headers: h });
}

const EmailSchema = MemberSchema.shape.email;

export function mountAuth(app: AppType): void {
  app.get(AUTH.login, async (c) => {
    // Access start exists only while Access sign-in is enabled (the callback
    // already refuses otherwise).
    if (!authConfig(c.env).providers.has("access"))
      throw new ApiError("not_found", "Not found");
    const { location, stateCookie, evict } = await buildAuthorizeRedirect(
      c.env,
      accessProvider,
      c.req.query("next") ?? "/",
      {
        retry: c.req.query("retry") === "1",
        cookieHeader: c.req.header("cookie"),
      },
    );
    return redirect(location, [...evict, stateCookie]);
  });

  app.get(AUTH.callback, async (c) => {
    // The Access callback exists only while Access sign-in is enabled.
    if (!authConfig(c.env).providers.has("access"))
      throw new ApiError("not_found", "Not found");
    // This attempt's state cookie is single-use: cleared on success and on
    // every failure. Other attempts' cookies (other tabs) are left alone.
    const picked = await pickStateCookie(
      c.env,
      c.req.raw,
      c.req.query("state") ?? "",
    );
    const clear = picked ? [clearOidcCookie(c.env, picked.name)] : [];
    try {
      const { email, name, next } = await handleCallback(
        c.env,
        accessProvider,
        c.req.raw,
      );
      const user = await upsertOnLogin(c.env, email, name);
      if (!user) {
        logOidcFail("no_access");
        return redirect(PAGES.noAccess, clear);
      }
      // The epoch must come from the row: a guest reactivated after #368,
      // or any user whose epoch a role change bumped, is otherwise issued a
      // dead cookie (e:0) and loops 401 -> /auth/login.
      const row = await getUserWithEpoch(c.env, user.id);
      if (!row) {
        logOidcFail("no_access");
        return redirect(PAGES.noAccess, clear);
      }
      const sess = sessionCookie(
        await signSession(c.env, user.id, Date.now(), {
          provider: "access",
          epoch: row.sessionEpoch,
        }),
        c.env,
      );
      return redirect(next, [...clear, sess]);
    } catch (e) {
      if (e instanceof OidcStateError) {
        if (e.retry) return retryPage(e.next, clear);
        return redirect(
          `${AUTH.login}?next=${encodeURIComponent(e.next)}&retry=1`,
          clear,
        );
      }
      const res = toErrorResponse(e);
      for (const k of clear) res.headers.append("set-cookie", k);
      res.headers.set("cache-control", "no-store");
      return res;
    }
  });

  // CSRF-guarded by csrf() in createApp.
  app.post(AUTH.logout, (c) => {
    const h = new Headers({ "cache-control": "no-store" });
    h.append("set-cookie", clearSessionCookie(c.env));
    return new Response(null, { status: 204, headers: h });
  });

  app.get(AUTH.devLogin, async (c) => {
    if (c.env.ENVIRONMENT !== "dev")
      throw new ApiError("not_found", "Not found");
    const email = EmailSchema.safeParse((c.req.query("email") ?? "").trim());
    const role = RoleSchema.safeParse(c.req.query("role") ?? "member");
    if (!email.success || normEmail(email.data) === null)
      throw new ApiError("bad_request", "Invalid email");
    if (!role.success) throw new ApiError("bad_request", "Invalid role");
    const user = await upsertWithRole(c.env, email.data, role.data);
    const row = await getUserWithEpoch(c.env, user.id);
    const sess = sessionCookie(
      await signSession(c.env, user.id, Date.now(), {
        provider: "dev",
        epoch: row?.sessionEpoch ?? 0,
      }),
      c.env,
    );
    return redirect(safeNext(c.env, c.req.query("next")), [sess]);
  });
}
