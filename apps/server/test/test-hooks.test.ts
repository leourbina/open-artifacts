import { env } from "cloudflare:workers";
import {
  AUTH,
  HealthzSchema,
  MeSchema,
  OAuthClientHookResultSchema,
  R,
  TEST_HOOKS,
  TEST_HOOKS_ALLOWED,
  TestSessionResultSchema,
} from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emailKey } from "../src/auth/codes.js";
import { sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { revokeAllGrants } from "../src/mcp/oauth-api.js";
import { direct, mailer, seedUser, uniq } from "./auth-helpers.js";

// P2 Task 14: test hooks for P5's cross-tenant suite.
const KEY = "k".repeat(32);
const ON = { TEST_HOOKS: "1", TEST_HOOK_KEY: KEY };
afterEach(() => vi.restoreAllMocks());

async function call(
  e: Env,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    key?: string;
    host?: string;
    scheme?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const waits: Promise<unknown>[] = [];
  const r = await worker.fetch(
    new Request(
      `${init.scheme ?? "http"}://${init.host ?? "app.localhost"}${path}`,
      {
        method: init.method ?? "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.200",
          ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
    ) as never,
    e,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as never,
  );
  await Promise.all(waits);
  return r;
}
const on = (over: Partial<Env> = {}) => ({ ...env, ...ON, ...over }) as Env;
const hook = (e: Env, path: string, body?: unknown, key = KEY) =>
  call(e, path, { body: body ?? {}, key });

describe("activation", () => {
  it("the test build allows hooks", () => {
    expect(TEST_HOOKS_ALLOWED).toBe(true);
  });

  it("off: every method and path is the standard 404", async () => {
    const ref = await call(env, TEST_HOOKS.session, { body: {} });
    expect(ref.status).toBe(404);
    expect(await ref.json()).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
    for (const method of ["GET", "POST", "PUT", "DELETE"])
      for (const p of [
        TEST_HOOKS.session,
        TEST_HOOKS.otpLatest,
        TEST_HOOKS.oauthClient,
        "/__test/x",
      ])
        expect(
          (
            await call(env, p, {
              method,
              body: method === "GET" ? undefined : {},
              key: KEY,
            })
          ).status,
        ).toBe(404);
    expect(
      (
        await call(
          { ...env, TEST_HOOKS: "0", TEST_HOOK_KEY: KEY } as Env,
          TEST_HOOKS.session,
          { body: {}, key: KEY },
        )
      ).status,
    ).toBe(404);
  });

  it("on with a 31-char key is still off", async () => {
    const short = "s".repeat(31);
    expect(
      (
        await hook(
          on({ TEST_HOOK_KEY: short }),
          TEST_HOOKS.session,
          { email: "a@a.com", role: "member" },
          short,
        )
      ).status,
    ).toBe(404);
  });

  it("a wrong or missing key gets the identical 404", async () => {
    const ref = await call(env, TEST_HOOKS.session, { body: {} });
    const refBody = await ref.text();
    for (const key of ["x".repeat(32), undefined]) {
      const r = await call(on(), TEST_HOOKS.session, {
        body: { email: "a@a.com", role: "member" },
        key,
      });
      expect(r.status).toBe(404);
      expect(await r.text()).toBe(refBody);
      expect(r.headers.get("content-type")).toBe(
        ref.headers.get("content-type"),
      );
    }
  });

  it("the content host is 404 even with the key", async () => {
    const r = await call(on(), TEST_HOOKS.session, {
      body: { email: "a@a.com", role: "member" },
      key: KEY,
      host: env.CONTENT_HOST,
    });
    expect(r.status).toBe(404);
  });

  it("off: no D1 or KV access", async () => {
    const d = vi.spyOn(env.DB, "prepare");
    const k = vi.spyOn(env.OAUTH_KV, "get");
    await call(env, TEST_HOOKS.session, { body: {}, key: KEY });
    expect(d).not.toHaveBeenCalled();
    expect(k).not.toHaveBeenCalled();
  });

  it("over RL_ANON (test:<install>:<ip>) is 404 too", async () => {
    const keys: string[] = [];
    const rl = {
      limit: async ({ key }: { key: string }) => (
        keys.push(key), { success: false }
      ),
    } as unknown as RateLimit;
    const r = await hook(on({ RL_ANON: rl }), TEST_HOOKS.session, {
      email: "a@a.com",
      role: "member",
    });
    expect(r.status).toBe(404);
    expect(keys).toEqual([`test:${env.APP_HOST}:198.51.100.200`]);
  });

  it("each call logs one test_hook event with no key, email or cookie", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: unknown) => {
      lines.push(String(s));
    });
    vi.spyOn(console, "warn").mockImplementation((s: unknown) => {
      lines.push(String(s));
    });
    const email = uniq("log");
    const r = await hook(on(), TEST_HOOKS.session, { email, role: "member" });
    const { cookie } = TestSessionResultSchema.parse(await r.json());
    await call(on(), TEST_HOOKS.session, { body: {}, key: "x".repeat(32) });
    const ev = lines.filter((l) => l.includes("test_hook"));
    expect(ev.map((l) => JSON.parse(l).evt)).toEqual([
      "test_hook.session",
      "test_hook.denied",
    ]);
    const all = lines.join("\n");
    for (const s of [KEY, email, cookie]) expect(all).not.toContain(s);
  });
});

describe("hooks", () => {
  it("session: a real cookie for that role; me.auth.method is test", async () => {
    const e = on({
      AUTH_PROVIDERS: "google,email",
      AUTH_DOMAINS: "a.com",
      GOOGLE_CLIENT_ID: "c",
      GOOGLE_CLIENT_SECRET: "s",
    });
    const r = await hook(e, TEST_HOOKS.session, {
      email: uniq("adm"),
      role: "admin",
    });
    expect(r.status).toBe(200);
    const { cookie } = TestSessionResultSchema.parse(await r.json());
    const me = MeSchema.parse(
      await (
        await call(e, R.me, {
          method: "GET",
          headers: { cookie: `${sessionCookieName(env)}=${cookie}` },
        })
      ).json(),
    );
    expect(me.user.role).toBe("admin");
    expect(me.auth?.method).toBe("test");
  });

  it("session: bad input is 400; spaces are refused until P3", async () => {
    expect(
      (await hook(on(), TEST_HOOKS.session, { email: "nope", role: "member" }))
        .status,
    ).toBe(400);
    expect(
      (
        await hook(on(), TEST_HOOKS.session, {
          email: uniq("sp"),
          role: "member",
          spaces: [{ spaceId: "s", role: "viewer" }],
        })
      ).status,
    ).toBe(400);
  });

  it("otp/latest: the code just sent; it verifies; then the hook 404s", async () => {
    const m = mailer();
    const e = { ...direct(), ...ON, ...m.env } as Env;
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const req = await call(e, AUTH.codeRequest, {
      body: { email: guest },
      headers: { "x-oa-request": "1", "sec-fetch-site": "same-origin" },
    });
    expect(req.status).toBe(202);
    const pending =
      req.headers
        .getSetCookie()
        .find((c) => c.startsWith("oa_code="))
        ?.split(";")[0] ?? "";
    const otp = await hook(e, TEST_HOOKS.otpLatest, { email: guest });
    expect(otp.status).toBe(200);
    const { code } = (await otp.json()) as { code: string };
    expect(code).toBe(m.codeFor(guest));
    const v = await call(e, AUTH.codeVerify, {
      body: { code },
      headers: {
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        cookie: pending,
      },
    });
    expect(v.status).toBe(200);
    expect((await hook(e, TEST_HOOKS.otpLatest, { email: guest })).status).toBe(
      404,
    );
  });

  it("off: a full code flow writes no plaintext anywhere", async () => {
    const m = mailer();
    const e = { ...direct(), ...m.env } as Env;
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const puts = vi.spyOn(env.OAUTH_KV, "put");
    await call(e, AUTH.codeRequest, {
      body: { email: guest },
      headers: { "x-oa-request": "1", "sec-fetch-site": "same-origin" },
    });
    const code = m.codeFor(guest);
    expect(puts).not.toHaveBeenCalled();
    const rows = JSON.stringify(
      (
        await env.DB.prepare("select * from login_codes where email_key = ?")
          .bind(await emailKey(e, guest))
          .all()
      ).results,
    );
    expect(rows).not.toContain(code);
    expect(rows).not.toContain(guest);
  });

  it("oauth-client: a real grant that works on /mcp and is revocable", async () => {
    const e = on();
    const r = await hook(e, TEST_HOOKS.oauthClient);
    expect(r.status).toBe(200);
    const { accessToken, clientId } = OAuthClientHookResultSchema.parse(
      await r.json(),
    );
    expect(clientId).toBeTruthy();
    const mcp = (t: string) =>
      call(e, "/mcp", {
        scheme: "https",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        headers: {
          authorization: `Bearer ${t}`,
          accept: "application/json, text/event-stream",
        },
      });
    expect((await mcp(accessToken)).status).toBe(200);
    const uid = (
      await env.DB.prepare("select id from users where email = ?")
        .bind(`p5-oauth@${env.APP_HOST}`)
        .first<{ id: string }>()
    )?.id;
    await revokeAllGrants(e, uid as string);
    expect((await mcp(accessToken)).status).toBe(401);
  });

  it("/healthz reports testHooks", async () => {
    const h = HealthzSchema.parse(
      await (await call(env, "/healthz", { method: "GET" })).json(),
    );
    expect(h.testHooks).toBeUndefined();
    expect(
      HealthzSchema.parse(
        await (await call(on(), "/healthz", { method: "GET" })).json(),
      ).testHooks,
    ).toBe(true);
  });
});
