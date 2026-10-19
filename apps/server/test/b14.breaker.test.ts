import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { login } from "./helpers.js";
import {
  APP,
  callWorker,
  connect,
  MCP_URL,
  nextIp,
  textOf,
  tool,
} from "./mcp-helpers.js";

const tag = newId().slice(0, 6).toLowerCase();

const listTools = (auth?: string) =>
  callWorker(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );

// ------------------------------------------------------------------- OAuth

const REDIRECT = "http://localhost:3333/cb";
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function register(name = "Test Agent"): Promise<string> {
  const r = await callWorker(
    new Request(`${APP}/oauth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": nextIp(),
      },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  expect(r.status).toBe(201);
  expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  return ((await r.json()) as { client_id: string }).client_id;
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

const authorizeUrl = (clientId: string, challenge: string) =>
  `${APP}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    resource: `${APP}/mcp`,
  })}`;

const cookiePairs = (r: Response) =>
  r.headers.getSetCookie().map((c) => c.split(";")[0] ?? "");

/** GET the consent page as `cookie`; returns its form fields and binding cookies. */
async function consentPage(url: string, cookie: string) {
  const r = await callWorker(new Request(url, { headers: { cookie } }));
  const body = await r.text();
  const field = (n: string) =>
    new RegExp(`name="${n}" value="([^"]*)"`).exec(body)?.[1] ?? "";
  return {
    r,
    body,
    csrf: field("csrf"),
    request: field("request"),
    cookies: cookiePairs(r),
  };
}

const decide = (
  cookie: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) => {
  const body = new URLSearchParams(fields).toString();
  return callWorker(
    new Request(`${APP}/oauth/authorize`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        ...headers,
      },
      body,
    }),
  );
};

/** Full flow for `email` (member): register → consent approve → token. */
async function oauthToken(email: string, clientName = "Test Agent") {
  const member = await login(email);
  const clientId = await register(clientName);
  const { verifier, challenge } = await pkce();
  const page = await consentPage(
    authorizeUrl(clientId, challenge),
    member.cookie,
  );
  expect(page.r.status).toBe(200);
  expect(page.body).toContain(clientName);
  expect(page.body).toContain(email);
  const r = await decide([member.cookie, ...page.cookies].join("; "), {
    csrf: page.csrf,
    request: page.request,
    decision: "approve",
  });
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("location") ?? "");
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("st4te");
  const code = loc.searchParams.get("code") ?? "";
  const t = await callWorker(
    new Request(`${APP}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": nextIp(),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${APP}/mcp`,
      }).toString(),
    }),
  );
  expect(t.status).toBe(200);
  const { access_token } = (await t.json()) as { access_token: string };
  return { member, accessToken: access_token, clientId };
}
const H = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const rpc = (method: string, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

describe("B14 breaker", () => {
  it("F1 demoted member (guest) loses the OAuth agent", async () => {
    const { member, accessToken } = await oauthToken(`brk-demote-${tag}@x.com`);
    await env.DB.prepare("update users set role='guest' where id=?")
      .bind(member.userId)
      .run();
    expect((await listTools(`Bearer ${accessToken}`)).status).toBe(401);
  });

  it("removed member's OAuth token → 401", async () => {
    const { member, accessToken } = await oauthToken(`brk-rm-${tag}@x.com`);
    await env.DB.prepare("delete from users where id=?")
      .bind(member.userId)
      .run();
    expect((await listTools(`Bearer ${accessToken}`)).status).toBe(401);
  });

  it("F2 /oauth/register is rate-limited per IP (KV write quota)", async () => {
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await callWorker(
        new Request(`${APP}/oauth/register`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.9",
          },
          body: JSON.stringify({
            client_name: `spam${i}`,
            redirect_uris: [REDIRECT],
            token_endpoint_auth_method: "none",
          }),
        }),
      );
      limited = r.status === 429;
    }
    expect(limited).toBe(true);
  });

  it("F3 unregistered redirect_uri never redirects", async () => {
    const m = await login(`brk-redir-${tag}@x.com`);
    const id = await register();
    const { challenge } = await pkce();
    const u = new URL(authorizeUrl(id, challenge));
    u.searchParams.set("redirect_uri", "https://evil.example/cb");
    const r = await callWorker(
      new Request(u, { headers: { cookie: m.cookie } }),
    );
    expect(r.status).not.toBe(302);
    u.searchParams.set("client_id", "nope");
    const r2 = await callWorker(
      new Request(u, { headers: { cookie: m.cookie } }),
    );
    expect(r2.headers.get("location") ?? "").not.toContain("evil");
  });

  it("F4 cookie alone at /mcp is ignored", async () => {
    const m = await login(`brk-cookie-${tag}@x.com`);
    const r = await callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: { ...H, cookie: m.cookie },
        body: rpc("tools/list"),
      }),
    );
    expect(r.status).toBe(401);
  });

  it("F5 /mcp body cap holds without content-length", async () => {
    const m = await login(`brk-body-${tag}@x.com`);
    const { token } = await createPat(env, m.userId, "b");
    const big = rpc("tools/call", {
      name: "publish_artifact",
      arguments: {
        title: "x",
        format: "markdown",
        content: "a".repeat(4_000_000),
      },
    });
    const bytes = new TextEncoder().encode(big);
    let i = 0;
    const body = new ReadableStream({
      pull(c) {
        if (i >= bytes.length) return c.close();
        c.enqueue(bytes.slice(i, i + 65536));
        i += 65536;
      },
    });
    const r = await callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: { ...H, authorization: `Bearer ${token}` },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(r.status).toBe(413);
  });

  it("F5b /mcp honors the configured ~3 MB cap with content-length (2025-era client)", async () => {
    const m = await login(`brk-body2-${tag}@x.com`);
    const { token } = await createPat(env, m.userId, "b");
    const big = rpc("tools/call", {
      name: "publish_artifact",
      arguments: {
        title: "x",
        format: "markdown",
        content: "a".repeat(3_600_000),
      },
    });
    const r = await callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          ...H,
          authorization: `Bearer ${token}`,
          "content-length": String(big.length),
        },
        body: big,
      }),
    );
    expect(r.status).toBe(413);
  });

  it("F6 header invariants on oauth/well-known errors", async () => {
    for (const [p, init] of [
      [
        "/oauth/token",
        {
          method: "POST",
          body: "grant_type=x",
          headers: { "content-type": "application/x-www-form-urlencoded" },
        },
      ],
      [
        "/oauth/register",
        {
          method: "POST",
          body: "{",
          headers: { "content-type": "application/json" },
        },
      ],
      ["/.well-known/oauth-protected-resource", {}],
      ["/oauth/authorize?client_id=x", {}],
      ["/mcp/", { method: "POST", body: "{}" }],
    ] as const) {
      const r = await callWorker(
        new Request(`${APP}${p}`, init as RequestInit),
      );
      expect(r.headers.get("x-robots-tag"), p).toBe("noindex, nofollow");
      if ((r.headers.get("content-type") ?? "").includes("html"))
        expect(r.headers.get("content-security-policy"), p).toBeTruthy();
    }
  });

  it("F7 data tools: editor share without db capability is denied; stranger 404", async () => {
    const o = await login(`brk-do-${tag}@x.com`);
    // Guests are refused at /mcp (fix round 1), so the stranger is a member.
    const s = await login(`brk-ds-${tag}@x.com`);
    const ot = (await createPat(env, o.userId, "o")).token;
    const st = (await createPat(env, s.userId, "s")).token;
    const oc = await connect(ot);
    const sc = await connect(st);
    const { id } = (
      await tool(oc, "publish_artifact", {
        title: "d",
        format: "markdown",
        content: "# d",
      })
    ).structuredContent as { id: string };
    const set = { id, collection: "c", docId: "d", data: { a: 1 } };
    expect(textOf(await tool(sc, "artifact_data_set", set))).toMatch(
      /^not_found/,
    );
    expect(
      textOf(
        await tool(sc, "share_artifact", {
          id,
          email: "z@x.com",
          role: "editor",
        }),
      ),
    ).toMatch(/^not_found/);
    expect(textOf(await tool(sc, "delete_artifact", { id }))).toMatch(
      /^not_found/,
    );
    await tool(oc, "share_artifact", {
      id,
      email: `brk-ds-${tag}@x.com`,
      role: "editor",
    });
    expect(textOf(await tool(sc, "artifact_data_set", set))).toMatch(
      /^capability_denied/,
    );
  });
});
