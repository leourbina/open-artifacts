import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { login } from "./helpers.js";
import { APP, callWorker, connect, MCP_URL } from "./mcp-helpers.js";

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

describe("MCP auth: PAT", () => {
  it("a revoked PAT → 401 with a resource-metadata challenge", async () => {
    const u = await login(`auth-rev-${tag}@x.com`);
    const { id, token } = await createPat(env, u.userId, "rev");
    const c = await connect(token);
    expect((await c.listTools()).tools.length).toBe(17);
    await c.close();
    await env.DB.prepare("update tokens set revoked_at = ? where id = ?")
      .bind(Date.now(), id)
      .run();
    const r = await listTools(`Bearer ${token}`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );
    expect(r.headers.get("www-authenticate")).toContain(
      `resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("an unknown PAT → 401; a deleted PAT → 401", async () => {
    const r = await listTools(`Bearer oa_pat_${"1".repeat(32)}`);
    expect(r.status).toBe(401);
    const u = await login(`auth-del-${tag}@x.com`);
    const { token } = await createPat(env, u.userId, "del");
    await env.DB.prepare("delete from tokens where user_id = ?")
      .bind(u.userId)
      .run();
    expect((await listTools(`Bearer ${token}`)).status).toBe(401);
  });

  it("a browser Origin other than the app host is rejected", async () => {
    const u = await login(`auth-origin-${tag}@x.com`);
    const { token } = await createPat(env, u.userId, "o");
    const r = await callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          origin: "https://evil.example",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});
