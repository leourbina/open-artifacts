import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { login } from "./helpers.js";
import { removeMember } from "../src/services/members.js";
import { APP, callWorker, connect, E, nextIp, tool } from "./mcp-helpers.js";

const tag = newId().slice(0, 6).toLowerCase();
const CONTENT = "https://content.localhost";
const REDIRECT = "http://localhost:3333/cb";

const req = (
  path: string,
  o: {
    method?: string;
    cookie?: string;
    bearer?: string;
    body?: unknown;
    ip?: string;
    headers?: Record<string, string>;
    host?: string;
  } = {},
) => {
  const h: Record<string, string> = { "x-oa-request": "1", ...o.headers };
  if (o.cookie) h.cookie = o.cookie;
  if (o.bearer) h.authorization = `Bearer ${o.bearer}`;
  if (o.ip) h["cf-connecting-ip"] = o.ip;
  if (o.body !== undefined) h["content-type"] = "application/json";
  return new Request(`${o.host ?? APP}${path}`, {
    method: o.method ?? "GET",
    headers: h,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
};
const w = (r: Request, e?: unknown) => callWorker(r, e);

async function create(cookie: string, extra: Record<string, unknown>) {
  const r = await w(
    req(R.artifacts, {
      method: "POST",
      cookie,
      body: { title: "t", format: "html", content: "<p>x</p>", ...extra },
    }),
  );
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function oauth(email: string, e?: unknown) {
  const m = await login(email);
  const reg = await w(
    new Request(`${APP}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": nextIp() },
      body: JSON.stringify({
        client_name: "Adv",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
    e,
  );
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const url = `${APP}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s",
    resource: `${APP}/mcp`,
  })}`;
  const page = await w(new Request(url, { headers: { cookie: m.cookie } }), e);
  const body = await page.text();
  const f = (n: string) =>
    new RegExp(`name="${n}" value="([^"]*)"`).exec(body)?.[1] ?? "";
  const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0]);
  const form = new URLSearchParams({
    csrf: f("csrf"),
    request: f("request"),
    decision: "approve",
  }).toString();
  const d = await w(
    new Request(`${APP}/oauth/authorize`, {
      method: "POST",
      headers: {
        cookie: [m.cookie, ...cookies].join("; "),
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(form.length),
      },
      body: form,
    }),
    e,
  );
  const code = new URL(d.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const t = await w(
    new Request(`${APP}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${APP}/mcp`,
      }).toString(),
    }),
    e,
  );
  expect(t.status).toBe(200);
  const j = (await t.json()) as { access_token: string; refresh_token: string };
  return { m, clientId, ...j };
}

const closedWithin = (ws: WebSocket, ms: number) =>
  new Promise<number | "open">((res) => {
    ws.addEventListener("close", (e) => res((e as CloseEvent).code));
    setTimeout(() => res("open"), ms);
  });

describe("M2 whole-track adversarial", () => {
  it("F1 publish with visibility change leaves live sockets open (patch closes them)", async () => {
    const owner = await login(`o1-${tag}@x.com`);
    const viewer = await login(`v1-${tag}@x.com`);
    const id = await create(owner.cookie, {
      visibility: "team",
      capabilities: { db: true },
    });
    const up = await w(
      req(`${R.dataSubscribe(id, "c")}`, {
        cookie: viewer.cookie,
        headers: { upgrade: "websocket" },
      }),
    );
    const ws = up.webSocket;
    if (!ws) throw new Error(`no ws ${up.status}`);
    ws.accept();
    const closed = closedWithin(ws, 1500);
    const v = await w(
      req(`/api/v1/artifacts/${id}/versions`, {
        method: "POST",
        cookie: owner.cookie,
        body: { format: "html", content: "<p>y</p>", visibility: "private" },
      }),
    );
    if (v.status !== 201) console.log("F1 body", await v.text());
    expect(v.status).toBe(201);
    // viewer has lost access (REST)…
    expect(
      (await w(req(R.dataCollection(id, "c"), { cookie: viewer.cookie }))).status,
    ).toBe(404);
    // …but the live feed keeps streaming.
    expect(await closed).toBe(4403);
  });

  it("F2 anonymous writer's IP is returned to every other viewer (updatedBy)", async () => {
    const owner = await login(`o2-${tag}@x.com`);
    const id = await create(owner.cookie, {
      visibility: "public",
      capabilities: { db: true },
      allowAnonymousWrites: true,
    });
    const put = await w(
      req(R.dataDoc(id, "c", "d1"), { method: "PUT", body: { v: 1 }, ip: "203.0.113.77" }),
    );
    expect(put.status).toBe(200);
    const list = await (await w(req(R.dataCollection(id, "c"), { ip: "198.51.100.1" }))).text();
    expect(list).not.toContain("203.0.113.77");
  });

  it("F3 refresh_token grant is unlimited and costs 2 KV writes each", async () => {
    let puts = 0;
    const kv = env.OAUTH_KV;
    const counting = new Proxy(kv, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "put") return (...a: unknown[]) => (puts++, (v as Function).apply(t, a));
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const e = E({ OAUTH_KV: counting });
    const o = await oauth(`o3-${tag}@x.com`, e);
    let rt = o.refresh_token;
    puts = 0;
    let ok = 0;
    for (let i = 0; i < 30; i++) {
      const r = await w(
        new Request(`${APP}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: rt,
            client_id: o.clientId,
          }).toString(),
        }),
        e,
      );
      if (r.status === 200) {
        ok++;
        rt = ((await r.json()) as { refresh_token: string }).refresh_token;
      }
    }
    // 1000 KV writes/day on Free: 500 refreshes by one client exhaust OAuth for everyone.
    expect({ ok, puts }).toEqual({ ok: expect.any(Number), puts: expect.any(Number) });
    console.log("F3", ok, puts);
    expect(ok).toBeLessThan(30); // FAILS: all 30 succeed, puts === 60
  });

  it("F4 rejected registrations past the daily cap still write D1", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "insert into counters (key,n,day) values ('oauth_register',200,?) on conflict(key) do update set n=200, day=excluded.day",
    )
      .bind(day)
      .run();
    for (let i = 0; i < 3; i++) {
      const r = await w(
        new Request(`${APP}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": nextIp() },
          body: JSON.stringify({ client_name: "x", redirect_uris: [REDIRECT] }),
        }),
      );
      expect(r.status).toBe(429);
    }
    const n = await env.DB.prepare("select n from counters where key='oauth_register'").first<{ n: number }>();
    await env.DB.prepare("update counters set n=0 where key='oauth_register'").run();
    expect(n?.n).toBe(200); // FAILS: 203 — each unauthenticated 429 is a D1 row write
  });

  it("F5 MCP data tools disagree with REST (viewer write, owner capability)", async () => {
    const owner = await login(`o5-${tag}@x.com`);
    const sv = await login(`sv5-${tag}@x.com`);
    const id = await create(owner.cookie, { capabilities: { db: true } });
    await w(req(`/api/v1/artifacts/${id}/shares`, { method: "PUT", cookie: owner.cookie, body: { email: `sv5-${tag}@x.com`, role: "viewer" } }));
    const rest = await w(req(R.dataDoc(id, "c", "a"), { method: "PUT", cookie: sv.cookie, body: { a: 1 } }));
    const { token } = await createPat(env, sv.userId, "agent");
    const c = await connect(token);
    const mcp = await tool(c, "artifact_data_set", { id, collection: "c", docId: "a", data: { a: 2 } });
    // owner, no db capability: REST 403; MCP keeps the owner exemption (B14 brief)
    const id2 = await create(owner.cookie, {});
    const rest2 = await w(req(R.dataDoc(id2, "c", "a"), { method: "PUT", cookie: owner.cookie, body: {} }));
    const { token: ot } = await createPat(env, owner.userId, "agent");
    const mcp2 = await tool(await connect(ot), "artifact_data_set", { id: id2, collection: "c", docId: "a", data: {} });
    console.log("F5", JSON.stringify({ rest: rest.status, mcp: mcp.content?.[0]?.text, rest2: rest2.status, mcp2: mcp2.content?.[0]?.text }));
    expect({ rest: rest.status, mcpErr: !!mcp.isError, rest2: rest2.status, mcp2Err: !!mcp2.isError }).toEqual({
      rest: 200, mcpErr: false, rest2: 403, mcp2Err: false,
    });
    // MCP writes as the user (shares the REST rate bucket), not as "agent:".
    expect(String(mcp.structuredContent?.updatedBy)).toBe(`u:${sv.userId}`);
  });

  it("F6 rows written per anonymous data write (DO Free: 100k rows/day)", async () => {
    const owner = await login(`o6-${tag}@x.com`);
    const id = await create(owner.cookie, { visibility: "public", capabilities: { db: true }, allowAnonymousWrites: true });
    await w(req(R.dataDoc(id, "c", "warm"), { method: "PUT", body: 1, ip: "203.0.113.90" }));
    let written = 0;
    await runInDurableObject(
      runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (inst, state) => {
        const sql = state.storage.sql;
        const orig = sql.exec.bind(sql);
        (sql as { exec: unknown }).exec = (...a: Parameters<typeof orig>) => {
          const cur = orig(...a);
          const arr = cur.toArray();
          written += cur.rowsWritten;
          return Object.assign(arr[Symbol.iterator](), { toArray: () => arr, one: () => arr[0], rowsWritten: cur.rowsWritten });
        };
        inst.setRaw("c", "d", new TextEncoder().encode('{"v":2}'), "ip:203.0.113.90");
      },
    );
    console.log("rows written per anon write:", written);
    expect(written).toBeLessThanOrEqual(3);
  });

  describe("required probes (expected to hold)", () => {
    it("(a) bearer routing", async () => {
      const m = await login(`a-${tag}@x.com`);
      const rpc = (auth: Record<string, string>, path = "/mcp") =>
        w(new Request(`${APP}${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
      expect((await rpc({ authorization: "Bearer notapat" })).status).toBe(401);
      expect((await rpc({ authorization: "Bearer oa_pat_" })).status).toBe(401);
      expect((await rpc({ cookie: m.cookie })).status).toBe(401);
      const { token } = await createPat(env, m.userId, "x");
      expect((await rpc({ authorization: `Bearer ${token}` }, "/mcp/")).status).toBe(401);
      const o = await oauth(`a2-${tag}@x.com`);
      expect((await w(req("/api/v1/me", { bearer: o.access_token, cookie: o.m.cookie }))).status).toBe(401);
      await login(`owner@example.com`, "owner").catch(() => {});
      await removeMember(env, o.m.userId);
      expect((await rpc({ authorization: `Bearer ${o.access_token}` })).status).toBe(401);
      await removeMember(env, m.userId);
      expect((await rpc({ authorization: `Bearer ${token}` })).status).toBe(401);
    });

    it("(b) guest at consent → 403", async () => {
      const g = await login(`g-${tag}@x.com`, "guest");
      const r = await w(new Request(`${APP}/oauth/authorize?client_id=x`, { headers: { cookie: g.cookie } }));
      expect(r.status).toBe(403);
    });

    it("(d) public→private: /p/, OG, thumbnail, cross-id data", async () => {
      const owner = await login(`d-${tag}@x.com`);
      const id = await create(owner.cookie, { visibility: "public", title: "Secret plan" });
      expect((await w(req(`/p/${id}/v1/__view`, { host: CONTENT }))).status).toBe(200);
      await w(req(`/api/v1/artifacts/${id}`, { method: "PATCH", cookie: owner.cookie, body: { visibility: "private" } }));
      expect((await w(req(`/p/${id}/v1/__view`, { host: CONTENT }))).status).toBe(404);
      expect((await w(req(`/p/${id}/v1/index.html`, { host: CONTENT }))).status).toBe(404);
      const og = await w(req(`/a/${id}`));
      if (og.status === 200) expect(await og.text()).not.toContain("Secret plan");
      expect((await w(req(`/api/v1/artifacts/${id}/thumbnail`))).status).toBe(404);
      const other = await login(`d2-${tag}@x.com`);
      expect((await w(req(R.dataCollection(id, "c"), { cookie: other.cookie }))).status).toBe(404);
    });
  });
});
