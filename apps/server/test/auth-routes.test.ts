import { env } from "cloudflare:workers";
import {
  AUTH,
  AuthProvidersSchema,
  MeSchema,
  R,
  SIGN_IN_PAGE,
} from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { readSession, sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import * as directory from "../src/services/directory.js";
import {
  direct,
  seedUser,
  TEST_BROKER_KEY,
  trial,
  uniq,
} from "./auth-helpers.js";
import { type FakeGoogle, fakeGoogle } from "./fixtures/fake-google.js";
import { login } from "./helpers.js";

// P2 Task 6: providers endpoint, Google routes, Me sign-in fields.
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const APP = "http://app.localhost";
const SESSION = sessionCookieName(env);
const get = (path: string, e: Env = env, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );
const del = (path: string, e: Env, cookie: string) =>
  app.fetch(
    new Request(`${APP}${path}`, {
      method: "DELETE",
      headers: { cookie, "x-oa-request": "1" },
    }),
    e,
    ctx,
  );
const loc = (r: Response) => r.headers.get("location") ?? "";
const cookieVal = (r: Response, name: string) =>
  r.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .split(";")[0];

let g: FakeGoogle;
beforeEach(async () => {
  g = await fakeGoogle();
});
afterEach(() => vi.restoreAllMocks());

/** Runs /auth/login/google → fake Google → /auth/callback/google. */
async function googleRoundTrip(
  e: Env,
  claims: Record<string, unknown> = {},
  next = "/a/x",
) {
  const start = await get(
    `${AUTH.loginGoogle}?next=${encodeURIComponent(next)}`,
    e,
  );
  expect(start.status).toBe(302);
  const u = new URL(loc(start));
  const set =
    start.headers.getSetCookie().find((c) => /oa_oidc_/.test(c)) ?? "";
  const stateCookie = set.split(";")[0] ?? "";
  const code = g.issueCode(
    { nonce: u.searchParams.get("nonce"), ...claims },
    u.searchParams.get("code_challenge") as string,
  );
  return get(
    `${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=${code}`,
    e,
    stateCookie,
  );
}

describe("GET /auth/providers", () => {
  it("access-only: just access, and /auth/login still goes to Access", async () => {
    const r = await get(AUTH.providers);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({
      mode: "access",
      providers: [{ id: "access", start: AUTH.login }],
    });
    expect(new URL(loc(await get(`${AUTH.login}?next=/`))).hostname).toBe(
      env.ACCESS_TEAM_DOMAIN,
    );
  });

  it("direct: google and email, parsed by the contract schema", async () => {
    const body = AuthProvidersSchema.parse(
      await (await get(AUTH.providers, direct())).json(),
    );
    expect(body).toEqual({
      mode: "direct",
      providers: [
        { id: "google", start: AUTH.loginGoogle, domains: ["a.com"] },
        { id: "email", domainCodes: false, guests: true },
      ],
    });
  });

  it("trial: domain codes on and the Turnstile site key", async () => {
    expect(await (await get(AUTH.providers, trial())).json()).toEqual({
      mode: "direct",
      providers: [
        { id: "email", domainCodes: true, guests: true, turnstileSiteKey: "k" },
      ],
    });
  });

  it("only fully configured providers; never secrets or problems", async () => {
    const r = await get(AUTH.providers, direct({ GOOGLE_CLIENT_SECRET: "" }));
    const text = await r.text();
    expect(JSON.parse(text).providers.map((p: { id: string }) => p.id)).toEqual(
      ["email"],
    );
    expect(text).not.toContain("problem");
  });

  it("does no D1 work, even with a session cookie", async () => {
    const { cookie } = await login(uniq("prov"));
    const spy = vi.spyOn(env.DB, "prepare");
    await get(AUTH.providers, env, cookie);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("direct-mode sign-in routes", () => {
  it("/auth/login goes to the SPA sign-in page with a safe next", async () => {
    expect(loc(await get(`${AUTH.login}?next=/a/x`, direct()))).toBe(
      `${SIGN_IN_PAGE}?next=%2Fa%2Fx`,
    );
    expect(loc(await get(`${AUTH.login}?next=//evil.com`, direct()))).toBe(
      `${SIGN_IN_PAGE}?next=%2F`,
    );
  });

  it("Google is 404 when it isn't configured", async () => {
    expect(
      (await get(AUTH.loginGoogle, direct({ AUTH_DOMAINS: "" }))).status,
    ).toBe(404);
    expect((await get(AUTH.loginGoogle, env)).status).toBe(404);
  });

  it("round trip: session p=google t=a.com, 7 days, redirect to next", async () => {
    const e = direct();
    const email = uniq("bob");
    const r = await googleRoundTrip(e, { email, sub: `rt-${email}` });
    expect(r.status).toBe(302);
    expect(loc(r)).toBe("/a/x");
    const set = r.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION}=`));
    expect(set).toContain("Max-Age=604800");
    expect(await readSession(e, cookieVal(r, SESSION))).toMatchObject({
      p: "google",
      t: "a.com",
      e: 0,
    });
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it.each([
    ["tenant", { hd: "b.com" }],
    ["failed", { aud: "other" }],
  ])(
    "refusal %s lands on the sign-in page with next, no session",
    async (reason, claims) => {
      const r = await googleRoundTrip(direct(), {
        email: uniq("x"),
        ...claims,
      });
      expect(loc(r)).toBe(`${SIGN_IN_PAGE}?error=${reason}&next=%2Fa%2Fx`);
      expect(cookieVal(r, SESSION)).toBeUndefined();
    },
  );

  it("identity_conflict, removed and no_access land on the sign-in page too", async () => {
    const a = uniq("conf");
    await seedUser(a, "member", { googleSub: `old-${a}` });
    expect(
      loc(await googleRoundTrip(direct(), { email: a, sub: `new-${a}` })),
    ).toBe(`${SIGN_IN_PAGE}?error=identity_conflict&next=%2Fa%2Fx`);
    const b = uniq("gone");
    await seedUser(b, "member", { status: "removed" });
    expect(
      loc(await googleRoundTrip(direct(), { email: b, sub: `s-${b}` })),
    ).toBe(`${SIGN_IN_PAGE}?error=removed&next=%2Fa%2Fx`);
    const c = uniq("nope");
    expect(
      loc(
        await googleRoundTrip(direct({ AUTH_DOMAIN_JOIN: "invite" }), {
          email: c,
          sub: `s-${c}`,
        }),
      ),
    ).toBe(`${SIGN_IN_PAGE}?error=no_access&next=%2Fa%2Fx`);
  });

  it("a stale state retries once, then expired on the sign-in page", async () => {
    const first = await get(`${AUTH.callbackGoogle}?state=s&code=c`, direct());
    expect(loc(first)).toBe(`${AUTH.loginGoogle}?next=%2F&retry=1`);
    const second = await get(
      `${AUTH.callbackGoogle}?state=r1.s&code=c`,
      direct(),
    );
    expect(loc(second)).toBe(`${SIGN_IN_PAGE}?error=expired&next=%2F`);
  });

  it("no COOP on the sign-in page and the Google routes", async () => {
    for (const p of [SIGN_IN_PAGE, AUTH.loginGoogle, AUTH.callbackGoogle])
      expect(
        (await get(p, direct())).headers.get("cross-origin-opener-policy"),
      ).toBeNull();
  });

  it("MCP connector: authorize → login → sign-in page → Google → back to authorize", async () => {
    const authorize = "/oauth/authorize?client_id=c&response_type=code";
    const toSignIn = loc(
      await get(
        `${AUTH.login}?next=${encodeURIComponent(authorize)}`,
        direct(),
      ),
    );
    const next = new URL(toSignIn, APP).searchParams.get("next") as string;
    expect(next).toBe(authorize);
    const email = uniq("mcp");
    expect(
      loc(await googleRoundTrip(direct(), { email, sub: `m-${email}` }, next)),
    ).toBe(authorize);
  });

  it("onGoogleSignIn runs once after admission, never on refusal; a failure doesn't block", async () => {
    const spy = vi.spyOn(directory, "onGoogleSignIn").mockResolvedValue();
    const email = uniq("dir");
    await googleRoundTrip(direct(), { email, sub: `d-${email}` });
    expect(spy).toHaveBeenCalledOnce();
    await googleRoundTrip(direct(), { email: uniq("t"), hd: "b.com" });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRejectedValue(new Error("down"));
    const e2 = uniq("dir2");
    expect(
      loc(await googleRoundTrip(direct(), { email: e2, sub: `d-${e2}` })),
    ).toBe("/a/x");
  });

  it("broker transport isn't offered yet (T11)", async () => {
    const e = direct({
      AUTH_BROKER_URL: "https://auth.h.test",
      BROKER_SIGNING_KEY: TEST_BROKER_KEY,
    });
    expect((await get(AUTH.loginGoogle, e)).status).toBe(404);
  });
});

describe("Me sign-in fields", () => {
  const me = async (e: Env, auth: string) => {
    const headers: Record<string, string> = auth.startsWith("oa_pat_")
      ? { authorization: `Bearer ${auth}` }
      : { cookie: auth };
    return MeSchema.parse(
      await (
        await app.fetch(new Request(`${APP}${R.me}`, { headers }), e, ctx)
      ).json(),
    );
  };

  it("access-only installs omit them (shape unchanged)", async () => {
    const { cookie } = await login(uniq("plain"));
    const m = await me(env, cookie);
    expect(m.auth).toBeUndefined();
    expect(m.instance.hosted).toBeUndefined();
    expect(m.instance.signIn).toBeUndefined();
  });

  it("direct: auth for a session and a PAT, signIn, features, hosted", async () => {
    const e = direct({ HOSTED: "1", FEATURES: "spaces" });
    const { cookie, userId } = await login(uniq("me"));
    const m = await me(e, cookie);
    expect(m.auth).toMatchObject({
      method: "access",
      readOnly: false,
      cap: null,
    });
    expect(typeof m.auth?.expiresAt).toBe("string");
    expect(m.instance).toMatchObject({
      hosted: true,
      signIn: { mode: "direct", providers: ["google", "email"] },
      features: ["spaces", "guests_read_only"],
    });
    const pat = await createPat(e, userId, "t");
    expect((await me(e, pat.token)).auth).toEqual({
      method: "pat",
      readOnly: false,
      cap: null,
      expiresAt: null,
    });
  });

  it("a guest under direct sign-in is read-only with cap guest", async () => {
    const { cookie } = await login(uniq("guest", "x.com"), "guest");
    expect((await me(direct(), cookie)).auth).toMatchObject({
      readOnly: true,
      cap: "guest",
    });
  });
});

describe("DELETE R.memberIdentity", () => {
  it("owner or admin resets a member's link; members get 404; never the owner's", async () => {
    const e = direct();
    const admin = await login(uniq("adm"), "admin");
    const mem = await login(uniq("mem"), "member");
    const target = await seedUser(uniq("tgt"), "member", {
      googleSub: `t-${crypto.randomUUID()}`,
    });
    expect(
      (await del(R.memberIdentity(target, "google"), e, mem.cookie)).status,
    ).toBe(404);
    expect(
      (await del(R.memberIdentity(target, "google"), e, admin.cookie)).status,
    ).toBe(204);
    expect(
      (await del(R.memberIdentity(target, "google"), e, admin.cookie)).status,
    ).toBe(404);
    const owner = await seedUser(uniq("own"), "owner", {
      googleSub: `o-${crypto.randomUUID()}`,
    });
    expect(
      (await del(R.memberIdentity(owner, "google"), e, admin.cookie)).status,
    ).toBe(404);
  });
});
