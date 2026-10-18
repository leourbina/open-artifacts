import { AUTH, MemberSchema, PAGES, RoleSchema } from "@oa/shared";
import {
  buildAuthorizeRedirect,
  clearOidcCookie,
  handleCallback,
  safeNext,
} from "../auth/oidc.js";
import {
  clearSessionCookie,
  sessionCookie,
  signSession,
} from "../auth/session.js";
import { normEmail } from "../db/email.js";
import { ApiError, toErrorResponse } from "../http/errors.js";
import { upsertOnLogin, upsertWithRole } from "../services/users.js";
import type { AppType } from "./index.js";

const redirect = (location: string, cookies: string[]) => {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
};

const EmailSchema = MemberSchema.shape.email;

export function mountAuth(app: AppType): void {
  app.get(AUTH.login, async (c) => {
    const { location, stateCookie } = await buildAuthorizeRedirect(
      c.env,
      c.req.query("next") ?? "/",
    );
    return redirect(location, [stateCookie]);
  });

  app.get(AUTH.callback, async (c) => {
    // oa_oidc is single-use: cleared on success and on every failure.
    const clear = clearOidcCookie(c.env);
    try {
      const { email, name, next } = await handleCallback(c.env, c.req.raw);
      const user = await upsertOnLogin(c.env, email, name);
      if (!user) return redirect(PAGES.noAccess, [clear]);
      const sess = sessionCookie(await signSession(c.env, user.id), c.env);
      return redirect(next, [clear, sess]);
    } catch (e) {
      const res = toErrorResponse(e);
      res.headers.append("set-cookie", clear);
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
    const sess = sessionCookie(await signSession(c.env, user.id), c.env);
    return redirect(safeNext(c.env, c.req.query("next")), [sess]);
  });
}
