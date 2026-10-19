// Plan-aware limits (env PLAN): data docs 256 KB on Free / 1 MB on Paid on
// every write path, and the generic /mcp body cap checked before any parse.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  dataDocTooLargeMessage,
  LIMITS,
  type Member,
  mcpTooLargeMessage,
  newId,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { errOf, fetchAndWait, login } from "./helpers.js";
import { callWorker, E, MCP_URL } from "./mcp-helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const FREE = { ...(env as Env), PLAN: undefined } as Env;
const PAID = { ...(env as Env), PLAN: "paid" } as Env;
let owner: { cookie: string; member: Member };
let pat: string;

beforeAll(async () => {
  const l = await login(`plan-${tag}@x.com`);
  const m = await getUser(env as Env, l.userId);
  if (!m) throw new Error("no user");
  owner = { cookie: l.cookie, member: m };
  pat = (await createPat(env as Env, l.userId, "plan-agent")).token;
});

/** An artifact whose DO runs with `e` (the DO reads PLAN from its own env). */
async function art(e: Env): Promise<string> {
  const id = (
    await publish(
      env as Env,
      owner.member,
      {
        title: "data",
        format: "html",
        content: "<p>x</p>",
        capabilities: { db: true, viewer: true, storage: true },
      } as never,
      null,
    )
  ).id;
  await runInDurableObject(
    runtimeStub(e, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    (i) => {
      (i as unknown as { env: Env }).env = e;
    },
  );
  return id;
}

/** A doc whose minified JSON is about `bytes` (escape-light text). */
const doc = (bytes: number) => JSON.stringify({ text: "x".repeat(bytes - 11) });

/** A request whose body stream counts reads; `length` sets Content-Length. */
function send(
  method: string,
  url: string,
  body: string,
  e: Env,
  headers: Record<string, string>,
  length = true,
) {
  const bytes = new TextEncoder().encode(body);
  const state = { read: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (state.read >= bytes.length) return c.close();
        const n = Math.min(16 * 1024, bytes.length - state.read);
        c.enqueue(bytes.slice(state.read, state.read + n));
        state.read += n;
      },
    },
    { highWaterMark: 0 },
  );
  const req = new Request(url, {
    method,
    headers: {
      ...headers,
      ...(length ? { "content-length": String(bytes.length) } : {}),
    },
    body: stream,
    duplex: "half",
  } as RequestInit);
  const res = url.startsWith(MCP_URL)
    ? callWorker(req, e)
    : fetchAndWait(app, req, e);
  return { res, state, size: bytes.length };
}
const rest = (
  method: string,
  path: string,
  body: string,
  e: Env,
  length = true,
) =>
  send(
    method,
    `http://app.localhost${path}`,
    body,
    e,
    {
      cookie: owner.cookie,
      "x-oa-request": "1",
      "content-type": "application/json",
    },
    length,
  );
const mcp = (
  args: Record<string, unknown>,
  name: string,
  e: Env,
  length = true,
) =>
  send(
    "POST",
    MCP_URL,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    e,
    {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${pat}`,
    },
    length,
  );
/** The JSON-RPC message of an MCP answer (JSON or one SSE event). */
const rpcOf = async (r: Response) => {
  const t = await r.text();
  return JSON.parse(/^data: (.*)$/m.exec(t)?.[1] ?? t) as {
    id: unknown;
    result?: { isError?: boolean; content: { text: string }[] };
    error?: { code: number; message: string };
  };
};
const FREE_MSG = dataDocTooLargeMessage("free");

describe("data docs: 256 KB on Free, 1 MB on Paid", () => {
  it("REST PUT over the Free limit → 413 with the plan message", async () => {
    const id = await art(FREE);
    const r = await rest("PUT", R.dataDoc(id, "c", "a"), doc(300 * 1024), FREE)
      .res;
    expect(r.status).toBe(413);
    expect(await errOf(r)).toMatchObject({
      code: "too_large",
      message: FREE_MSG,
    });
    const ok = await rest("PUT", R.dataDoc(id, "c", "a"), doc(250 * 1024), FREE)
      .res;
    expect(ok.status).toBe(200);
  });

  it("REST: a body over the Free doc cap is refused before it is read", async () => {
    const id = await art(FREE);
    const { res, state } = rest(
      "PUT",
      R.dataDoc(id, "c", "a"),
      doc(LIMITS.dataDocBytesFree + 128 * 1024),
      FREE,
    );
    const r = await res;
    expect(r.status).toBe(413);
    expect((await errOf(r)).message).toBe(FREE_MSG);
    expect(state.read).toBe(0);
  });

  it("REST PATCH and storage PUT over the Free limit → 413", async () => {
    const id = await art(FREE);
    const big = doc(300 * 1024);
    const p = await rest("PATCH", R.dataDoc(id, "c", "b"), big, FREE).res;
    expect(p.status).toBe(413);
    expect((await errOf(p)).message).toBe(FREE_MSG);
    const s = await rest(
      "PUT",
      R.storageKey(id, "k"),
      JSON.stringify({ value: "x".repeat(300 * 1024) }),
      FREE,
    ).res;
    expect(s.status).toBe(413);
    expect((await errOf(s)).message).toBe(FREE_MSG);
  });

  it("Paid: a ~1 MB doc is accepted over REST", async () => {
    const id = await art(PAID);
    const r = await rest(
      "PUT",
      R.dataDoc(id, "c", "a"),
      doc(LIMITS.dataDocBytesPaid - 1024),
      PAID,
    ).res;
    expect(r.status).toBe(200);
  });

  it("MCP artifact_data_set / update over the Free limit → too_large with the plan message", async () => {
    const id = await art(FREE);
    const data = { text: "x".repeat(270 * 1024) };
    for (const [tool, args] of [
      ["artifact_data_set", { data }],
      ["artifact_data_update", { patch: data }],
    ] as const) {
      const r = await mcp(
        { id, collection: "c", docId: "a", ...args },
        tool,
        FREE,
      ).res;
      const m = await rpcOf(r);
      expect(m.result?.isError).toBe(true);
      expect(m.result?.content[0]?.text).toBe(`too_large: ${FREE_MSG}`);
    }
  });

  it("the runtime bridge path (the DO) enforces the plan's limit", async () => {
    const free = await art(FREE);
    const paid = await art(PAID);
    const big = "x".repeat(300 * 1024);
    await expect(
      runtimeStub(FREE, free).set("c", "a", big, "u:1"),
    ).rejects.toThrow(FREE_MSG);
    await expect(
      runtimeStub(FREE, free).setRaw("c", "a", JSON.stringify(big), "u:1"),
    ).rejects.toThrow(FREE_MSG);
    await expect(
      runtimeStub(FREE, free).update("c", "b", { big }, "u:1"),
    ).rejects.toThrow(FREE_MSG);
    await expect(
      runtimeStub(PAID, paid).set("c", "a", big, "u:1"),
    ).resolves.toBeTruthy();
  });
});

describe("/mcp body cap (before any parse)", () => {
  it("Free: a declared body over 320 KB → 413 JSON-RPC error, unread", async () => {
    const id = await art(FREE);
    const { res, state, size } = mcp(
      { id, collection: "c", docId: "a", data: { t: "x".repeat(330 * 1024) } },
      "artifact_data_set",
      FREE,
    );
    expect(size).toBeGreaterThan(LIMITS.mcpBodyBytesFree);
    const r = await res;
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: mcpTooLargeMessage("free") },
    });
    expect(state.read).toBe(0);
  });

  it("Free: with no Content-Length the read stops at the cap", async () => {
    const { res, state, size } = mcp(
      { title: "t", format: "html", content: "x".repeat(4 * 1024 * 1024) },
      "publish_artifact",
      FREE,
      false,
    );
    const r = await res;
    expect(r.status).toBe(413);
    expect((await rpcOf(r)).error?.message).toBe(mcpTooLargeMessage("free"));
    expect(state.read).toBeLessThanOrEqual(LIMITS.mcpBodyBytesFree + 16 * 1024);
    expect(state.read).toBeLessThan(size);
  });

  it("Paid: a 900 KB data doc over MCP is accepted", async () => {
    const id = await art(PAID);
    const r = await mcp(
      { id, collection: "c", docId: "a", data: { t: "x".repeat(900 * 1024) } },
      "artifact_data_set",
      PAID,
    ).res;
    const m = await rpcOf(r);
    expect(m.result?.isError).toBeUndefined();
  });

  it("Paid: over 1 MB + 64 KB → 413 with the Paid message", async () => {
    const r = await mcp(
      { title: "t", format: "html", content: "x".repeat(1200 * 1024) },
      "publish_artifact",
      PAID,
    ).res;
    expect(r.status).toBe(413);
    expect((await rpcOf(r)).error?.message).toBe(mcpTooLargeMessage("paid"));
  });
});

describe("/healthz", () => {
  it("reports the plan, public and cheap", async () => {
    for (const [e, plan] of [
      [FREE, "free"],
      [E({ PLAN: "paid" }), "paid"],
      [E({ PLAN: "PAID" }), "free"],
    ] as const) {
      const r = await fetchAndWait(
        app,
        new Request("http://app.localhost/healthz"),
        e,
      );
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, plan });
    }
  });
});
