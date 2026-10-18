import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../src/app.js";
import { accessIssuer, safeNext } from "../src/auth/oidc.js";
import { createPat } from "../src/auth/pat.js";
import { readSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { type AppVariables, session } from "../src/http/middleware.js";
import { b64urlEncode } from "../src/util/crypto.js";
import { login } from "./helpers.js";

const APP = "http://app.localhost";
const ISS = accessIssuer(env);
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

// ---------- fake Access OIDC issuer (served through a global fetch spy) ----------
let priv: CryptoKey;
let jwk: Record<string, unknown>;
type CodeEntry = { challenge: string; claims: JWTPayload; key?: CryptoKey };
const codes = new Map<string, CodeEntry>();
let tokenStatus = 200;
let tokenRaw: string | null = null;
let tokenResp: (() => Response) | null = null;
let tokenCalls: { body: URLSearchParams }[] = [];

const issuer = new Hono();
issuer.get("/jwks", (c) => c.json({ keys: [jwk] }));
issuer.post("/token", async (c) => {
  const body = new URLSearchParams(await c.req.text());
  tokenCalls.push({ body });
  if (tokenResp) return tokenResp();
  if (tokenStatus !== 200)
    return c.text("upstream-secret-detail", tokenStatus as 500);
  if (tokenRaw !== null)
    return new Response(tokenRaw, {
      headers: { "content-type": "application/json" },
    });
  const entry = codes.get(body.get("code") ?? "");
  if (!entry) return c.json({ error: "invalid_grant" }, 400);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body.get("code_verifier") ?? ""),
  );
  if (b64urlEncode(new Uint8Array(digest)) !== entry.challenge)
    return c.json({ error: "invalid_grant" }, 400);
  const now = Math.floor(Date.now() / 1000);
  const id_token = await new SignJWT({
    iss: ISS,
    aud: env.ACCESS_CLIENT_ID,
    iat: now,
    exp: now + 300,
    sub: "sub-1",
    ...entry.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .sign(entry.key ?? priv);
  return c.json({ id_token, access_token: "at", token_type: "Bearer" });
});

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  priv = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
});

beforeEach(() => {
  tokenStatus = 200;
  tokenRaw = null;
  tokenResp = null;
  tokenCalls = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url.startsWith(`${ISS}/`)) {
      const u = new URL(req.url);
      u.pathname = u.pathname.slice(new URL(ISS).pathname.length);
      return issuer.fetch(new Request(u, req));
    }
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

// ---------- helpers ----------
const app = createApp();
const call = (path: string, init?: RequestInit, e: Env = env) =>
  app.fetch(new Request(`${APP}${path}`, init), e, ctx);

const setCookies = (r: Response) => r.headers.getSetCookie();
const cookieVal = (r: Response, name: string) => {
  const c = setCookies(r).find((s) => s.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(";")[0] : undefined;
};

/** Runs /auth/login, registers a code at the fake issuer, returns callback inputs. */
async function begin(
  claims: JWTPayload,
  next = "/a/xyz",
  e: Env = env,
  key?: CryptoKey,
) {
  const r = await call(`/auth/login?next=${encodeURIComponent(next)}`, {}, e);
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("location") ?? "");
  const oidc = cookieVal(r, "oa_oidc");
  const state = loc.searchParams.get("state") ?? "";
  const nonce = loc.searchParams.get("nonce") ?? "";
  const code = newId();
  codes.set(code, {
    challenge: loc.searchParams.get("code_challenge") ?? "",
    claims: { nonce, ...claims },
    key,
  });
  return { code, state, nonce, oidc, loc, res: r };
}

const callback = (
  q: { code: string; state: string },
  oidc: string | undefined,
  e: Env = env,
) =>
  call(
    `/auth/callback?code=${q.code}&state=${encodeURIComponent(q.state)}`,
    { headers: oidc === undefined ? {} : { cookie: `oa_oidc=${oidc}` } },
    e,
  );

const userByEmail = (email: string) =>
  env.DB.prepare("select * from users where email = ?")
    .bind(email)
    .first<{ id: string; role: string; name: string }>();

async function expect401(r: Response) {
  expect(r.status).toBe(401);
  const text = await r.text();
  expect(JSON.parse(text).error.code).toBe("unauthorized");
  expect(text).not.toContain("upstream-secret-detail");
  expect(
    setCookies(r).some((c) => c.startsWith("oa_oidc=;") && /Max-Age=0/.test(c)),
  ).toBe(true);
  expect(cookieVal(r, "oa_session")).toBeUndefined();
}

// ---------- tests ----------
describe("GET /auth/login", () => {
  it("redirects to the Access authorize endpoint with PKCE S256", async () => {
    const { loc, res } = await begin({});
    expect(loc.origin).toBe(`https://${env.ACCESS_TEAM_DOMAIN}`);
    expect(loc.pathname).toBe(
      `/cdn-cgi/access/sso/oidc/${env.ACCESS_CLIENT_ID}/authorization`,
    );
    const p = loc.searchParams;
    expect(p.get("client_id")).toBe(env.ACCESS_CLIENT_ID);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe(`${APP}/auth/callback`);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["openid", "email"]),
    );
    expect(p.get("state")?.length).toBeGreaterThanOrEqual(32);
    expect(p.get("nonce")?.length).toBeGreaterThanOrEqual(32);
    const c = setCookies(res).find((s) => s.startsWith("oa_oidc="));
    expect(c).toMatch(/; HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Path=\/auth(;|$)/);
    expect(c).toMatch(/Max-Age=600/);
    // dev env → no Secure; production → Secure
    expect(c).not.toMatch(/Secure/);
    const prod = await call(
      "/auth/login",
      {},
      { ...env, ENVIRONMENT: "production" },
    );
    expect(setCookies(prod).find((s) => s.startsWith("oa_oidc="))).toMatch(
      /; Secure/,
    );
    // verifier never leaks in the URL
    expect(loc.href).not.toContain("verifier");
  });
});

describe("safeNext", () => {
  it("keeps same-origin paths only", () => {
    expect(safeNext(env, "/a/xyz?v=2#h")).toBe("/a/xyz?v=2#h");
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      "evil.com",
      "",
      "/\t/evil.com",
      "javascript:alert(1)",
      undefined,
      "/..//evil.com",
      "/.//evil.com",
      "/a/..//evil.com",
      "/a/..\\/evil.com",
      "/%2e%2e//evil.com",
      "/a/../\\evil.com",
    ])
      expect(safeNext(env, bad)).toBe("/");
  });
  it("caps the serialized length", () => {
    expect(safeNext(env, `/${"é".repeat(2000)}`)).toBe("/");
    expect(safeNext(env, `/${"a".repeat(2000)}`)).toBe(`/${"a".repeat(2000)}`);
  });
  it("oa_oidc cookie stays under 4096 chars for long next", async () => {
    const r = await call(
      `/auth/login?next=${encodeURIComponent(`/${"é".repeat(2000)}`)}`,
    );
    const c = setCookies(r).find((x) => x.startsWith("oa_oidc=")) ?? "";
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThan(4096);
    const r2 = await call(
      `/auth/login?next=${encodeURIComponent(`/${"a".repeat(2040)}`)}`,
    );
    const c2 = setCookies(r2).find((x) => x.startsWith("oa_oidc=")) ?? "";
    expect(c2.length).toBeLessThan(4096);
  });
});

describe("GET /auth/callback", () => {
  it("valid code flow logs in OWNER_EMAIL as owner", async () => {
    const e = { ...env, OWNER_EMAIL: "Owner@X.com" };
    const b = await begin({ email: "owner@x.com", name: "Olive" }, "/a/xyz", e);
    const r = await callback(b, b.oidc, e);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/a/xyz");
    const sess = await readSession(env, cookieVal(r, "oa_session"));
    const row = await userByEmail("owner@x.com");
    expect(row?.role).toBe("owner");
    expect(row?.name).toBe("Olive");
    expect(sess?.uid).toBe(row?.id);
    expect(
      setCookies(r).some(
        (c) => c.startsWith("oa_oidc=;") && /Max-Age=0/.test(c),
      ),
    ).toBe(true);
    // token exchange carried PKCE verifier + client creds
    const body = tokenCalls[0]?.body;
    expect(body?.get("grant_type")).toBe("authorization_code");
    expect(body?.get("client_secret")).toBe(env.ACCESS_CLIENT_SECRET);
    expect(body?.get("redirect_uri")).toBe(`${APP}/auth/callback`);
  });

  it("promotes an existing member to owner", async () => {
    await login("promote@x.com", "member");
    const e = { ...env, OWNER_EMAIL: "promote@x.com" };
    const b = await begin({ email: "PROMOTE@x.com" }, "/", e);
    expect((await callback(b, b.oidc, e)).status).toBe(302);
    expect((await userByEmail("promote@x.com"))?.role).toBe("owner");
  });

  it("existing invited member keeps role, gets name updated", async () => {
    await login("mem@x.com", "admin");
    const b = await begin({ email: "Mem@X.com", name: "New Name" });
    const r = await callback(b, b.oidc);
    expect(r.status).toBe(302);
    const row = await userByEmail("mem@x.com");
    expect(row?.role).toBe("admin");
    expect(row?.name).toBe("New Name");
  });

  it("rejects wrong nonce", async () => {
    const b = await begin({ email: "n@x.com", nonce: "wrong" });
    await expect401(await callback(b, b.oidc));
  });
  it("rejects wrong aud", async () => {
    const b = await begin({ email: "n@x.com", aud: "other-client" });
    await expect401(await callback(b, b.oidc));
  });
  it("rejects wrong iss", async () => {
    const b = await begin({ email: "n@x.com", iss: "https://evil.example" });
    await expect401(await callback(b, b.oidc));
  });
  it("rejects expired token (beyond 60s tolerance)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const b = await begin({ email: "n@x.com", exp: now - 120, iat: now - 600 });
    await expect401(await callback(b, b.oidc));
  });
  it("rejects token signed by an unknown key", async () => {
    const other = await generateKeyPair("RS256");
    const b = await begin({ email: "n@x.com" }, "/", env, other.privateKey);
    await expect401(await callback(b, b.oidc));
  });
  it("rejects email_verified=false and missing email", async () => {
    const b1 = await begin({ email: "n@x.com", email_verified: false });
    await expect401(await callback(b1, b1.oidc));
    const b2 = await begin({});
    await expect401(await callback(b2, b2.oidc));
  });
  it("rejects missing state cookie", async () => {
    const b = await begin({ email: "n@x.com" });
    await expect401(await callback(b, undefined));
  });
  it("rejects forged state cookie", async () => {
    const b = await begin({ email: "n@x.com" });
    const [p, sig] = (b.oidc ?? "").split(".");
    const payload = JSON.parse(
      atob((p ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    );
    const forged = b64urlEncode(
      new TextEncoder().encode(JSON.stringify({ ...payload, state: "x" })),
    );
    await expect401(await callback({ ...b, state: "x" }, `${forged}.${sig}`));
  });
  it("rejects state mismatch", async () => {
    const b = await begin({ email: "n@x.com" });
    await expect401(await callback({ ...b, state: `${b.state}x` }, b.oidc));
  });
  it("rejects expired state cookie", async () => {
    const b = await begin({ email: "n@x.com" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    try {
      await expect401(await callback(b, b.oidc));
    } finally {
      vi.useRealTimers();
    }
  });
  it("token endpoint error → 401 without upstream body", async () => {
    const b = await begin({ email: "n@x.com" });
    tokenStatus = 500;
    await expect401(await callback(b, b.oidc));
  });
  it("Access error param → 401", async () => {
    const b = await begin({ email: "n@x.com" });
    const r = await call(
      `/auth/callback?error=access_denied&state=${b.state}`,
      { headers: { cookie: `oa_oidc=${b.oidc}` } },
    );
    await expect401(r);
  });

  it("next=https://evil.com redirects to /", async () => {
    await login("evil@x.com");
    const b = await begin({ email: "evil@x.com" }, "https://evil.com");
    const r = await callback(b, b.oidc);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
  });

  it("unknown email with no shares → /no-access, no row", async () => {
    const b = await begin({ email: "nobody@x.com" });
    const r = await callback(b, b.oidc);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/no-access");
    expect(cookieVal(r, "oa_session")).toBeUndefined();
    expect(await userByEmail("nobody@x.com")).toBeNull();
  });

  it("unknown email with a share → guest row", async () => {
    const { userId } = await login("sharer@x.com");
    const aid = newId();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "insert into artifacts (id, owner_id, title, format, created_at, updated_at) values (?, ?, 't', 'html', ?, ?)",
      ).bind(aid, userId, now, now),
      env.DB.prepare(
        "insert into shares (artifact_id, email, role, created_by, created_at) values (?, 'guest@x.com', 'viewer', ?, ?)",
      ).bind(aid, userId, now),
    ]);
    const b = await begin({ email: "Guest@X.com" });
    const r = await callback(b, b.oidc);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/a/xyz");
    const row = await userByEmail("guest@x.com");
    expect(row?.role).toBe("guest");
    expect((await readSession(env, cookieVal(r, "oa_session")))?.uid).toBe(
      row?.id,
    );
  });
});

describe("email folding", () => {
  it("Kelvin-sign email is no-access, no row (no fold onto owner)", async () => {
    const e = { ...env, OWNER_EMAIL: "kim@x.com" };
    const b = await begin({ email: "\u212Aim@x.com" }, "/", e);
    const r = await callback(b, b.oidc, e);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/no-access");
    expect(cookieVal(r, "oa_session")).toBeUndefined();
    expect(await userByEmail("kim@x.com")).toBeNull();
    const n = await env.DB.prepare(
      "select count(*) as n from users where email like '%im@x.com'",
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("id_token claims", () => {
  it("accepts a token without iat", async () => {
    const b = await begin({ email: "noiat@x.com", iat: undefined });
    await login("noiat@x.com");
    expect((await callback(b, b.oidc)).status).toBe(302);
  });
});

describe("POST /auth/logout", () => {
  it("clears oa_session with 204; GET is not allowed", async () => {
    const r = await call("/auth/logout", { method: "POST" });
    expect(r.status).toBe(204);
    const c = setCookies(r).find((s) => s.startsWith("oa_session="));
    expect(c).toBe("oa_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    const prod = await call(
      "/auth/logout",
      { method: "POST" },
      { ...env, ENVIRONMENT: "production" },
    );
    expect(setCookies(prod)).toContain(
      "oa_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    );
    expect((await call("/auth/logout")).status).toBe(404);
  });
});

describe("session middleware", () => {
  const probe = createApp((a) => {
    const g = a as unknown as Hono<{ Bindings: Env; Variables: AppVariables }>;
    g.use("/probe", session());
    g.get("/probe", (c) =>
      c.json({ user: c.var.user, tokenLabel: c.var.tokenLabel }),
    );
  });
  const get = async (headers: Record<string, string>) =>
    (await (
      await probe.fetch(new Request(`${APP}/probe`, { headers }), env, ctx)
    ).json()) as {
      user: { id: string; email: string; role: string } | null;
      tokenLabel: string | null;
    };

  it("cookie → user", async () => {
    const { cookie, userId } = await login("Sess@X.com", "admin");
    const r = await get({ cookie });
    expect(r.user).toMatchObject({
      id: userId,
      email: "sess@x.com",
      role: "admin",
    });
    expect(r.tokenLabel).toBeNull();
  });
  it("bearer PAT → user + tokenLabel", async () => {
    const { userId } = await login("pat-sess@x.com");
    const { token } = await createPat(env, userId, "my-agent");
    const r = await get({ authorization: `Bearer ${token}` });
    expect(r.user?.id).toBe(userId);
    expect(r.tokenLabel).toBe("my-agent");
  });
  it("bearer wins over cookie (invalid bearer → null, no fallback)", async () => {
    const { cookie } = await login("both@x.com");
    const r = await get({ cookie, authorization: "Bearer oa_pat_nope" });
    expect(r.user).toBeNull();
  });
  it("non-Bearer Authorization falls through to the cookie", async () => {
    const { cookie, userId } = await login("basic@x.com");
    const r = await get({ cookie, authorization: "Basic dXNlcjpwYXNz" });
    expect(r.user?.id).toBe(userId);
  });
  it("non-PAT Bearer shadows the cookie (null)", async () => {
    const { cookie } = await login("jwtb@x.com");
    expect(
      (await get({ cookie, authorization: "Bearer eyJhbGciOi.x.y" })).user,
    ).toBeNull();
  });
  it("no/garbage cookie → null; deleted user → null", async () => {
    expect((await get({})).user).toBeNull();
    expect((await get({ cookie: "oa_session=garbage" })).user).toBeNull();
    const { cookie, userId } = await login("gone@x.com");
    await env.DB.prepare("delete from users where id = ?").bind(userId).run();
    expect((await get({ cookie })).user).toBeNull();
  });
});

describe("callback failure logging", () => {
  type Log = { evt: string; stage: string; [k: string]: unknown };
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  const logs = (): Log[] =>
    warn.mock.calls.map((a: unknown[]) => JSON.parse(String(a[0])) as Log);
  const raw = () =>
    warn.mock.calls.map((a: unknown[]) => a.join(" ")).join("\n");

  const EMAIL = "secret-person@leak.example";
  async function run(
    expectStage: string,
    setup: (
      b: Awaited<ReturnType<typeof begin>>,
    ) => Promise<Response> | Response,
    claims: JWTPayload = { email: EMAIL },
  ) {
    const b = await begin(claims);
    warn.mockClear();
    const r = await setup(b);
    const l = logs().filter((x) => x.evt === "oidc_fail");
    expect(l.map((x) => x.stage)).toEqual([expectStage]);
    const text = raw();
    for (const secret of [
      EMAIL,
      "leak.example",
      b.code,
      b.state,
      b.nonce,
      b.oidc ?? "",
      env.ACCESS_CLIENT_SECRET,
      env.SESSION_SECRET,
      "upstream-secret-detail",
      "eyJ",
    ])
      expect(text).not.toContain(secret);
    return { r, l: l[0] as Log };
  }

  it("no_state_cookie", async () => {
    await run("no_state_cookie", (b) => callback(b, undefined));
  });
  it("state_bad_sig", async () => {
    await run("state_bad_sig", (b) => callback(b, `${b.oidc}x`));
  });
  it("state_expired", async () => {
    await run("state_expired", async (b) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      try {
        return await callback(b, b.oidc);
      } finally {
        vi.useRealTimers();
      }
    });
  });
  it("state_mismatch", async () => {
    await run("state_mismatch", (b) =>
      callback({ ...b, state: `${b.state}x` }, b.oidc),
    );
  });
  it("idp_error with sanitized error", async () => {
    const { l } = await run("idp_error", (b) =>
      call(
        `/auth/callback?error=${encodeURIComponent("Access_Denied<script>")}&state=${encodeURIComponent(b.state)}`,
        { headers: { cookie: `oa_oidc=${b.oidc}` } },
      ),
    );
    expect(l.error).toMatch(/^access_denied[a-z_]{0,51}$/);
  });
  it("token_http_<status>", async () => {
    tokenStatus = 502;
    const { r } = await run("token_http_502", (b) => callback(b, b.oidc));
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain("upstream");
  });
  it("token 302 (Access error redirect) logs error + description", async () => {
    tokenResp = () =>
      new Response(null, {
        status: 302,
        headers: {
          location: `${APP}/auth/callback?error=invalid_client&error_description=${encodeURIComponent(`Client auth failed\u0000\n${"x".repeat(300)}`)}`,
        },
      });
    const { l, r } = await run("token_http_302", (b) => callback(b, b.oidc));
    expect(r.status).toBe(401);
    expect(l.error).toBe("invalid_client");
    expect(String(l.description)).toMatch(/^Client auth failedx+$/);
    expect(String(l.description).length).toBe(200);
    expect(await r.text()).not.toContain("invalid_client");
  });
  it("token 4xx JSON body logs error + description", async () => {
    tokenResp = () =>
      Response.json(
        { error: "invalid_grant", error_description: "Code expired" },
        { status: 400 },
      );
    const { l } = await run("token_http_400", (b) => callback(b, b.oidc));
    expect(l.error).toBe("invalid_grant");
    expect(l.description).toBe("Code expired");
  });
  it("token_bad_json", async () => {
    tokenRaw = "not json";
    await run("token_bad_json", (b) => callback(b, b.oidc));
  });
  it("no_id_token", async () => {
    tokenRaw = JSON.stringify({ access_token: "at" });
    await run("no_id_token", (b) => callback(b, b.oidc));
  });
  it("jwt_verify with code and claim", async () => {
    const { l } = await run("jwt_verify", (b) => callback(b, b.oidc), {
      email: EMAIL,
      aud: "other-client",
    });
    expect(l.code).toBe("ERR_JWT_CLAIM_VALIDATION_FAILED");
    expect(l.claim).toBe("aud");
    const { l: l2 } = await run("jwt_verify", (b) => callback(b, b.oidc), {
      email: EMAIL,
      exp: Math.floor(Date.now() / 1000) - 600,
    });
    expect(l2.code).toBe("ERR_JWT_EXPIRED");
    expect(l2.claim).toBe("exp");
  });
  it("aud (multi-audience)", async () => {
    await run("aud", (b) => callback(b, b.oidc), {
      email: EMAIL,
      aud: [env.ACCESS_CLIENT_ID, "other"],
    });
  });
  it("nonce", async () => {
    await run("nonce", (b) => callback(b, b.oidc), {
      email: EMAIL,
      nonce: "wrong",
    });
  });
  it("email", async () => {
    await run("email", (b) => callback(b, b.oidc), {});
  });
  it("email_unverified", async () => {
    await run("email_unverified", (b) => callback(b, b.oidc), {
      email: EMAIL,
      email_verified: false,
    });
  });
  it("no_access", async () => {
    const { r } = await run("no_access", (b) => callback(b, b.oidc));
    expect(r.headers.get("location")).toBe("/no-access");
  });
});
