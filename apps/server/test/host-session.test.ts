import { env } from "cloudflare:workers";
import { AUTH, R } from "@oa/shared";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mw } from "../src/auth/route-policy.js";
import {
  clearSessionCookie,
  sessionCookie,
  sessionCookieName,
  signSession,
} from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { type AppVariables, session } from "../src/http/middleware.js";
import { login } from "./helpers.js";

const prod: Env = { ...env, ENVIRONMENT: "production" };
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const HOST = sessionCookieName(prod);
const PLAIN = sessionCookieName(env);

describe("__Host- session cookie", () => {
  it("name: __Host- prefixed outside dev, plain in dev", () => {
    expect(HOST).toBe("__Host-oa_session");
    expect(PLAIN).toBe(HOST.slice("__Host-".length));
    expect(sessionCookieName({ ...env, ENVIRONMENT: "staging" } as never)).toBe(
      HOST,
    );
  });

  it("prod cookie: __Host-, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain", () => {
    expect(sessionCookie("v", prod)).toBe(
      `${HOST}=v; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`,
    );
    expect(sessionCookie("v", prod)).not.toMatch(/domain=/i);
    expect(clearSessionCookie(prod)).toBe(
      `${HOST}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    );
    expect(sessionCookie("v", env)).toBe(
      `${PLAIN}=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`,
    );
  });

  const probe = createApp(
    (a) => {
      const g = a as unknown as Hono<{
        Bindings: Env;
        Variables: AppVariables;
      }>;
      g.use("/probe", mw(session()));
      g.get("/probe", (c) => c.json({ user: c.var.user }));
    },
    { "GET /probe": { public: "test probe" } },
  );
  const who = async (cookie: string, e: Env) =>
    (
      (await (
        await probe.fetch(
          new Request("http://app.localhost/probe", { headers: { cookie } }),
          e,
          ctx,
        )
      ).json()) as { user: { id: string } | null }
    ).user;

  it("prod ignores a planted plain cookie (validly signed); reads __Host-", async () => {
    const { userId } = await login("host-sess@x.com");
    const v = await signSession(env, userId);
    expect(await who(`${PLAIN}=${v}`, prod)).toBeNull();
    expect((await who(`${HOST}=${v}`, prod))?.id).toBe(userId);
    // dev: plain name only
    expect((await who(`${PLAIN}=${v}`, env))?.id).toBe(userId);
    expect(await who(`${HOST}=${v}`, env)).toBeNull();
  });

  it("CSRF: only a plain cookie in prod is not a cookie session", async () => {
    const app = createApp();
    const post = (cookie: string) =>
      app.fetch(
        // Logout: public to the policy gate, guarded by CSRF.
        new Request(`http://app.localhost${AUTH.logout}`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: "{}",
        }),
        prod,
        ctx,
      );
    const plain = await post(`${PLAIN}=junk`);
    expect(plain.status).not.toBe(403);
    const host = await post(`${HOST}=junk`);
    expect(host.status).toBe(403);
    expect(
      ((await host.json()) as { error: { code: string } }).error.code,
    ).toBe("csrf");
  });

  it("logout clears the __Host- name in prod", async () => {
    const r = await createApp().fetch(
      new Request("http://app.localhost/auth/logout", {
        method: "POST",
        headers: { "x-oa-request": "1" },
      }),
      prod,
      ctx,
    );
    expect(r.status).toBe(204);
    expect(r.headers.getSetCookie()).toContain(clearSessionCookie(prod));
    expect(clearSessionCookie(prod).startsWith(`${HOST}=;`)).toBe(true);
  });
});
