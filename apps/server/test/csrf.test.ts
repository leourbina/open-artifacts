import { env } from "cloudflare:workers";
import { AUTH, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { login } from "./helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const call = (path: string, init: RequestInit) =>
  app.fetch(new Request(`http://app.localhost${path}`, init), env, ctx);
const errCode = async (r: Response) =>
  ((await r.json()) as { error: { code: string } }).error.code;

const tag = newId().slice(0, 6).toLowerCase();
let admin: { cookie: string; userId: string };
let pat: string;
const invite = (n: string) =>
  JSON.stringify({ email: `${n}-${tag}@x.com`, role: "member" });

beforeAll(async () => {
  admin = await login(`csrf-admin-${tag}@x.com`, "admin");
  pat = (await createPat(env, admin.userId, "ci")).token;
});

describe("csrf", () => {
  it("cookie POST without X-OA-Request → 403 csrf", async () => {
    const r = await call(R.members, {
      method: "POST",
      headers: { cookie: admin.cookie, "content-type": "application/json" },
      body: invite("a"),
    });
    expect(r.status).toBe(403);
    expect(await errCode(r)).toBe("csrf");
  });

  it("wrong header value → 403; PATCH/DELETE also guarded", async () => {
    const r = await call(R.members, {
      method: "POST",
      headers: {
        cookie: admin.cookie,
        "x-oa-request": "true",
        "content-type": "application/json",
      },
      body: invite("b"),
    });
    expect(r.status).toBe(403);
    for (const method of ["PATCH", "DELETE", "PUT"]) {
      const x = await call(R.member(newId()), {
        method,
        headers: { cookie: admin.cookie },
      });
      expect(x.status).toBe(403);
    }
    // Even an unauthenticated (bogus) cookie is checked before routing.
    const bogus = await call(R.members, {
      method: "POST",
      headers: { cookie: "oa_session=junk" },
    });
    expect(await errCode(bogus)).toBe("csrf");
  });

  it("cookie POST with the header passes", async () => {
    const r = await call(R.members, {
      method: "POST",
      headers: {
        cookie: admin.cookie,
        "x-oa-request": "1",
        "content-type": "application/json",
      },
      body: invite("c"),
    });
    expect(r.status).toBe(201);
  });

  it("PAT POST without the header passes (even with a cookie)", async () => {
    const r = await call(R.members, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat}`,
        "content-type": "application/json",
      },
      body: invite("d"),
    });
    expect(r.status).toBe(201);
    const r2 = await call(R.members, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat}`,
        cookie: admin.cookie,
        "content-type": "application/json",
      },
      body: invite("e"),
    });
    expect(r2.status).toBe(201);
  });

  it("GET with a cookie needs no header", async () => {
    const r = await call(R.members, { headers: { cookie: admin.cookie } });
    expect(r.status).toBe(200);
  });

  it("no cookie and no header: not a CSRF failure", async () => {
    const r = await call(R.members, { method: "POST", body: invite("f") });
    expect(r.status).toBe(401);
  });

  it("cross-site logout → 403 csrf, no Set-Cookie", async () => {
    for (const extra of [
      { "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example" },
      { origin: "null" },
    ] as Record<string, string>[]) {
      const r = await call(AUTH.logout, {
        method: "POST",
        headers: { cookie: admin.cookie, "x-oa-request": "1", ...extra },
      });
      expect(r.status).toBe(403);
      expect(await errCode(r)).toBe("csrf");
      expect(r.headers.getSetCookie()).toEqual([]);
    }
    const same = await call(AUTH.logout, {
      method: "POST",
      headers: {
        cookie: admin.cookie,
        "x-oa-request": "1",
        origin: "http://app.localhost",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(same.status).toBe(204);
  });

  it("POST /auth/logout is guarded", async () => {
    const r = await call(AUTH.logout, {
      method: "POST",
      headers: { cookie: admin.cookie },
    });
    expect(r.status).toBe(403);
    expect(await errCode(r)).toBe("csrf");
    expect(r.headers.getSetCookie()).toEqual([]);
    const ok = await call(AUTH.logout, {
      method: "POST",
      headers: { cookie: admin.cookie, "x-oa-request": "1" },
    });
    expect(ok.status).toBe(204);
  });
});
