import { env } from "cloudflare:workers";
import {
  AUTH,
  CodeRateLimitedDetailsSchema,
  CodeRequestedSchema,
  CodeVerifiedSchema,
  CodeVerifyFailureDetailsSchema,
  TurnstileRequiredDetailsSchema,
} from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { emailKey } from "../src/auth/codes.js";
import { readSession, sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import {
  direct,
  mailer,
  seedShare,
  seedUser,
  trial,
  uniq,
} from "./auth-helpers.js";

// P2 Task 8: code sign-in routes.
const app = createApp();
const APP = "http://app.localhost";
const SESSION = sessionCookieName(env);
const CODE_COOKIE = "oa_code"; // dev naming in the test env (prod: __Host-oa_code)
afterEach(() => vi.restoreAllMocks());

type Opts = {
  cookie?: string;
  ip?: string;
  headers?: Record<string, string>;
  waits?: Promise<unknown>[];
};
async function post(e: Env, path: string, body: unknown, o: Opts = {}) {
  const waits = o.waits ?? [];
  const r = await app.fetch(
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip":
          o.ip ?? `198.51.100.${Math.floor(Math.random() * 250)}`,
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...o.headers,
      },
      body: JSON.stringify(body),
    }),
    e,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as never,
  );
  if (!o.waits) await Promise.all(waits);
  return r;
}
const cookieOf = (r: Response, name: string) => {
  const c = r.headers.getSetCookie().find((s) => s.startsWith(`${name}=`));
  return c ? `${name}=${c.slice(name.length + 1).split(";")[0]}` : undefined;
};
const setCookieLine = (r: Response, name: string) =>
  r.headers.getSetCookie().find((s) => s.startsWith(`${name}=`)) ?? "";
const errOf = async (r: Response) =>
  ((await r.json()) as { error: { code: string; details?: unknown } }).error;
const withMail = (e: Env, m = mailer()) => ({ ...e, ...m.env }) as Env;
const request = (
  e: Env,
  email: string,
  o: Opts & { token?: string; next?: string } = {},
) =>
  post(
    e,
    AUTH.codeRequest,
    {
      email,
      next: o.next ?? "/a/x",
      ...(o.token ? { turnstileToken: o.token } : {}),
    },
    o,
  );
const verify = (
  e: Env,
  code: string,
  cookie: string | undefined,
  o: Opts = {},
) => post(e, AUTH.codeVerify, { code }, { ...o, cookie });

describe("POST AUTH.codeRequest", () => {
  it("the 202 is byte-identical for eligible, ineligible and email-off addresses", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const m = mailer();
    const on = withMail(direct(), m);
    const a = await request(on, guest);
    const b = await request(on, uniq("nobody", "x.com"));
    const c = await request(direct(), guest);
    const aBody = await a.text();
    expect(a.status).toBe(202);
    for (const r of [b, c]) {
      expect(r.status).toBe(a.status);
      const body = JSON.parse(await r.text());
      expect(Object.keys(body)).toEqual(Object.keys(JSON.parse(aBody)));
      expect(body.expiresIn).toBe(600);
    }
    expect(CodeRequestedSchema.parse(JSON.parse(aBody))).toMatchObject({
      expiresIn: 600,
      resendAfter: 60,
      codeLength: 8,
    });
    expect(m.sent.map((x) => x.to)).toEqual([guest]);
  });

  it("masks the address and sets the pending cookie (HttpOnly, Lax, 10 min)", async () => {
    const r = await request(direct(), "someone@x.com");
    expect(CodeRequestedSchema.parse(await r.json()).maskedEmail).toBe(
      "s***@x.com",
    );
    expect(setCookieLine(r, CODE_COOKIE)).toMatch(
      /HttpOnly; SameSite=Lax; Path=\/; Max-Age=600/,
    );
  });

  it("delivery runs after the response (waitUntil)", async () => {
    const guest = uniq("w", "x.com");
    await seedUser(guest, "guest");
    const m = mailer();
    const waits: Promise<unknown>[] = [];
    const r = await request(withMail(direct(), m), guest, { waits });
    expect(r.status).toBe(202);
    expect(m.sent).toHaveLength(0);
    await Promise.all(waits);
    expect(m.sent).toHaveLength(1);
  });

  it("a fourth request from one IP within 10 minutes is 429 scope email, eligible or not", async () => {
    for (const addr of [uniq("g", "x.com"), uniq("nobody", "x.com")]) {
      const ip = `203.0.113.${Math.floor(Math.random() * 250)}`;
      for (let i = 0; i < 3; i++)
        expect((await request(direct(), addr, { ip })).status).toBe(202);
      const r = await request(direct(), addr, { ip });
      expect(r.status).toBe(429);
      expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
      const err = await errOf(r);
      expect(err.code).toBe("rate_limited");
      expect(CodeRateLimitedDetailsSchema.parse(err.details).scope).toBe(
        "email",
      );
    }
  });

  it("RL_AUTH keys on the install and the IP; a denial is 429 scope ip", async () => {
    const keys: string[] = [];
    const rl = (success: boolean) =>
      ({
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success };
        },
      }) as unknown as RateLimit;
    await request(direct({ RL_AUTH: rl(true) }), uniq("x", "x.com"), {
      ip: "203.0.113.9",
    });
    expect(keys).toEqual(["inst-a:203.0.113.9"]);
    const r = await request(direct({ RL_AUTH: rl(false) }), uniq("x", "x.com"));
    expect(r.status).toBe(429);
    expect((await errOf(r)).details).toMatchObject({ scope: "ip" });
  });

  it("Turnstile configured: no token 400 turnstile_required; bad token 403 turnstile_failed; before any counter", async () => {
    const e = trial();
    const addr = uniq("t", "x.com");
    const r1 = await request(e, addr);
    expect(r1.status).toBe(400);
    const err = await errOf(r1);
    expect(err.code).toBe("turnstile_required");
    TurnstileRequiredDetailsSchema.parse(err.details);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: false }),
    );
    const r2 = await request(e, addr, { token: "bad" });
    expect(r2.status).toBe(403);
    expect((await errOf(r2)).code).toBe("turnstile_failed");
    const ek = await emailKey(e, addr);
    expect(
      await env.DB.prepare("select 1 from counters where key like ?")
        .bind(`code:%${ek}%`)
        .first(),
    ).toBeNull();
  });

  it("a passing Turnstile token lets a trial domain member through", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true }),
    );
    const owner = uniq("own");
    await seedUser(owner, "owner");
    const m = mailer();
    const r = await request(withMail(trial(), m), owner, { token: "ok" });
    expect(r.status).toBe(202);
    expect(m.sent.map((x) => x.to)).toEqual([owner]);
  });

  it("invalid email is 400 field email", async () => {
    const r = await request(direct(), "not-an-email");
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toEqual({ field: "email" });
  });

  it("codes off: both endpoints 404", async () => {
    const e = direct({ AUTH_PROVIDERS: "google" });
    expect((await request(e, "a@x.com")).status).toBe(404);
    expect((await verify(e, "12345678", undefined)).status).toBe(404);
  });

  it("cross-site or missing X-OA-Request or JSON is 403 csrf", async () => {
    for (const headers of <Record<string, string>[]>[
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "x-oa-request": "" },
      { "sec-fetch-site": "", origin: "https://evil.test" },
      { "content-type": "text/plain" },
    ]) {
      const r = await request(direct(), "a@x.com", { headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect((await errOf(r)).code).toBe("csrf");
    }
    // No Sec-Fetch-Site but an exact Origin passes.
    const ok = await request(direct(), uniq("o", "x.com"), {
      headers: { "sec-fetch-site": "", origin: APP },
    });
    expect(ok.status).toBe(202);
  });

  it("the outside-domain owner and a Google-linked user get no email", async () => {
    const owner = uniq("boss", "x.com");
    await seedUser(owner, "owner");
    const linked = uniq("linked");
    await seedUser(linked, "member", { googleSub: `L-${linked}` });
    const m = mailer();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true }),
    );
    await request(withMail(direct(), m), owner);
    await request(withMail(trial(), m), linked, { token: "ok" });
    expect(m.sent).toHaveLength(0);
  });
});

describe("POST AUTH.codeVerify", () => {
  async function start(e: Env, email: string, next = "/a/x") {
    const m = mailer();
    const em = withMail(e, m);
    const r = await request(em, email, { next });
    return {
      e: em,
      cookie: cookieOf(r, CODE_COOKIE),
      code: () => m.codeFor(email),
    };
  }

  it("guest round trip: 200 CodeVerified, readOnly, 24 h session p=code, cookie cleared", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const s = await start(direct(), guest);
    const r = await verify(s.e, s.code(), s.cookie);
    expect(r.status).toBe(200);
    const body = CodeVerifiedSchema.parse(await r.json());
    expect(body).toMatchObject({
      next: "/a/x",
      readOnly: true,
      user: { email: guest, role: "guest" },
    });
    expect(setCookieLine(r, SESSION)).toContain("Max-Age=86400");
    expect(
      await readSession(s.e, cookieOf(r, SESSION)?.split("=")[1]),
    ).toMatchObject({ p: "code" });
    expect(setCookieLine(r, CODE_COOKIE)).toContain("Max-Age=0");
  });

  it("a shared address with no row becomes a guest on verify", async () => {
    const addr = uniq("s", "x.com");
    await seedShare(addr);
    const s = await start(direct(), addr);
    const r = await verify(s.e, s.code(), s.cookie);
    expect(CodeVerifiedSchema.parse(await r.json()).user).toMatchObject({
      email: addr,
      role: "guest",
    });
  });

  it("trial domain member: 7 days, t = domain, not read-only", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true }),
    );
    const owner = uniq("own");
    await seedUser(owner, "owner");
    const m = mailer();
    const e = withMail(trial(), m);
    const r1 = await request(e, owner, { token: "ok" });
    const r = await verify(e, m.codeFor(owner), cookieOf(r1, CODE_COOKIE));
    expect(await r.json()).toMatchObject({
      readOnly: false,
      user: { role: "owner" },
    });
    expect(setCookieLine(r, SESSION)).toContain("Max-Age=604800");
    expect(
      await readSession(e, cookieOf(r, SESSION)?.split("=")[1]),
    ).toMatchObject({
      p: "code",
      t: "a.com",
    });
  });

  it("reasons come from the cookie: invalid_code 4..1, then expired", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const s = await start(direct(), guest);
    let cookie = s.cookie;
    for (const left of [4, 3, 2, 1]) {
      const r = await verify(s.e, "00000000", cookie);
      expect(r.status).toBe(401);
      expect(
        CodeVerifyFailureDetailsSchema.parse((await errOf(r)).details),
      ).toEqual({
        reason: "invalid_code",
        attemptsLeft: left,
      });
      cookie = cookieOf(r, CODE_COOKIE);
    }
    const last = await verify(s.e, "00000000", cookie);
    expect((await errOf(last)).details).toEqual({ reason: "expired" });
  });

  it('"1234 567" and "1234a5678" are invalid_code and each uses an attempt', async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const s = await start(direct(), guest);
    const r1 = await verify(s.e, "1234 567", s.cookie);
    expect((await errOf(r1)).details).toEqual({
      reason: "invalid_code",
      attemptsLeft: 4,
    });
    const r2 = await verify(s.e, "1234a5678", cookieOf(r1, CODE_COOKIE));
    expect((await errOf(r2)).details).toEqual({
      reason: "invalid_code",
      attemptsLeft: 3,
    });
  });

  it("an address that never got a code answers exactly like a wrong guess", async () => {
    const seqFor = async (email: string) => {
      const s = await start(direct(), email);
      let cookie = s.cookie;
      const out = [];
      for (let i = 0; i < 5; i++) {
        const r = await verify(s.e, "00000000", cookie);
        out.push([r.status, (await errOf(r)).details]);
        cookie = cookieOf(r, CODE_COOKIE) ?? cookie;
      }
      return out;
    };
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    expect(await seqFor(uniq("nobody", "x.com"))).toEqual(await seqFor(guest));
  });

  it("no cookie or a forged cookie: no_pending", async () => {
    for (const cookie of [undefined, `${CODE_COOKIE}=abc.def`]) {
      const r = await verify(direct(), "12345678", cookie);
      expect(r.status).toBe(401);
      expect((await errOf(r)).details).toEqual({ reason: "no_pending" });
    }
  });

  it("next is safeNext'd", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const s = await start(direct(), guest, "//evil.com");
    const r = await verify(s.e, s.code(), s.cookie);
    expect(CodeVerifiedSchema.parse(await r.json()).next).toBe("/");
  });

  it("the per-IP failure cap is 429 scope ip", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const ip = "192.0.2.99";
    let s = await start(direct(), guest);
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) {
      if (i % 5 === 0) s = await start(direct(), guest);
      last = await verify(s.e, "00000000", s.cookie, { ip });
    }
    expect(last?.status).toBe(429);
    expect((await errOf(last as Response)).details).toMatchObject({
      scope: "ip",
    });
  });

  it("a guest whose eligibility ended between request and verify is refused", async () => {
    const guest = uniq("g", "x.com");
    const id = await seedUser(guest, "guest");
    const s = await start(direct(), guest);
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(id)
      .run();
    const r = await verify(s.e, s.code(), s.cookie);
    expect(r.status).toBe(401);
    expect(cookieOf(r, SESSION)).toBeUndefined();
  });

  it("the code cookie can't be replayed from another install", async () => {
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const s = await start(direct(), guest);
    const other = { ...s.e, SESSION_SECRET: "q".repeat(32) } as Env;
    const r = await verify(other, s.code(), s.cookie);
    expect((await errOf(r)).details).toEqual({ reason: "no_pending" });
  });
});

describe("a SESSION_SECRET under 32 characters", () => {
  // No code keys can be derived, so the routes answer 503 code_unavailable
  // instead of a 500 on every request.
  const short = () => direct({ SESSION_SECRET: "s".repeat(20) });

  it("a code request is 503 code_unavailable", async () => {
    const r = await post(short(), AUTH.codeRequest, {
      email: "g@x.com",
      next: "/",
    });
    expect(r.status).toBe(503);
    expect(await errOf(r)).toMatchObject({ code: "code_unavailable" });
  });

  it("a verify that carries a pending cookie is 503 too", async () => {
    const r = await post(
      short(),
      AUTH.codeVerify,
      { code: "12345678" },
      { cookie: `${CODE_COOKIE}=abc.def` },
    );
    expect(r.status).toBe(503);
    expect(await errOf(r)).toMatchObject({ code: "code_unavailable" });
  });

  it("a verify with no pending cookie is still 401 before any key work", async () => {
    const r = await post(short(), AUTH.codeVerify, { code: "12345678" });
    expect(r.status).toBe(401);
    expect((await errOf(r)).details).toMatchObject({ reason: "no_pending" });
  });
});
