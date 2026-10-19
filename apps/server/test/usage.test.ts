import { env } from "cloudflare:workers";
import { newId, R, UsageSchema } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { api, fetchAndWait, login } from "./helpers.js";
import { connect, E, textOf, tool } from "./mcp-helpers.js";

const app = createApp();
let admin: { cookie: string };
let member: { cookie: string };
beforeAll(async () => {
  const t = newId().slice(0, 6).toLowerCase();
  admin = await login(`us-a-${t}@x.com`, "admin");
  member = await login(`us-m-${t}@x.com`, "member");
});
afterEach(() => vi.restoreAllMocks());

const gql = (over: object = {}, acct: object = {}) =>
  new Response(
    JSON.stringify({
      data: {
        viewer: {
          accounts: [
            {
              workers: [{ sum: { requests: 1200 } }],
              d1: [{ sum: { rowsRead: 3000, rowsWritten: 40 } }],
              dos: [{ sum: { requests: 77 } }],
              cpu: [{ quantiles: { cpuTimeP99: 8500 } }],
              cpuHits: [{ sum: { requests: 2 } }, { sum: { requests: 1 } }],
              ...acct,
            },
          ],
        },
      },
      errors: null,
      ...over,
    }),
    { headers: { "content-type": "application/json" } },
  );
const withToken = (token?: string) => ({
  ...(env as object),
  WORKER_NAME: "oa-test",
  ANALYTICS_TOKEN: token,
});
const graphqlCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) =>
    String(c[0] instanceof Request ? c[0].url : c[0]).includes("graphql"),
  );
const usageFor = async (e: unknown) =>
  UsageSchema.parse(await (await call(admin.cookie, e)).json());
const call = (cookie: string | null, e: unknown) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${R.usage}`, {
      headers: { ...(cookie ? { cookie } : {}), "x-oa-request": "1" },
    }),
    e,
  );

describe("usage", () => {
  it("owner/admin only; others 404", async () => {
    expect((await api(app, R.usage, member.cookie)).status).toBe(404);
    expect((await api(app, R.usage, null)).status).toBe(401);
  });

  it("no token -> unavailable", async () => {
    const r = await call(admin.cookie, withToken());
    const u = UsageSchema.parse(await r.json());
    expect(u).toMatchObject({ available: false, metrics: [] });
    expect(u.date).toMatch(/^\d{4}-\d\d-\d\d$/);
  });

  it("maps GraphQL metrics and caches for 5 minutes", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => gql());
    const e = { ...withToken("tok"), CF_ACCOUNT_ID: "acct-cache" };
    const u = UsageSchema.parse(await (await call(admin.cookie, e)).json());
    expect(u.available).toBe(true);
    expect(u.metrics).toEqual([
      { key: "requests", used: 1200, limit: 100000 },
      { key: "d1_reads", used: 3000, limit: 5000000 },
      { key: "d1_writes", used: 40, limit: 100000 },
      { key: "do_requests", used: 77, limit: 100000 },
      { key: "cpu_limit_hits", used: 3, limit: 0 },
      { key: "cpu_p99_ms", used: 8.5, limit: 10 },
    ]);
    const calls = spy.mock.calls.filter((c) =>
      String(c[0] instanceof Request ? c[0].url : c[0]).includes("graphql"),
    );
    expect(calls).toHaveLength(1);
    const init = calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
    const u2 = UsageSchema.parse(await (await call(admin.cookie, e)).json());
    expect(u2).toEqual(u);
    expect(
      spy.mock.calls.filter((c) => String(c[0]).includes("graphql")),
    ).toHaveLength(1);
  });

  it("GraphQL errors or bad shape -> available:false, not cached", async () => {
    const e = { ...withToken("tok"), CF_ACCOUNT_ID: "acct-err" };
    let n = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      n++;
      return n === 1
        ? gql({ errors: [{ message: "boom" }] })
        : new Response('{"data":{"nope":1}}', { status: 200 });
    });
    for (let i = 0; i < 2; i++) {
      const r = await call(admin.cookie, e);
      expect(r.status).toBe(200);
      expect(UsageSchema.parse(await r.json()).available).toBe(false);
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("CPU query: scriptName filter, outcome filter, today's window", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => gql());
    await usageFor({ ...withToken("tok"), CF_ACCOUNT_ID: "acct-cpu-q" });
    const init = graphqlCalls(spy)[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.query).toContain("scriptName: $s");
    expect(body.query).toContain(
      'status_in: ["exceededCpu", "exceededResources"]',
    );
    expect(body.query).toContain("cpuTimeP99");
    expect(body.variables.s).toBe("oa-test");
    expect(body.variables.from).toMatch(/^\d{4}-\d\d-\d\dT00:00:00Z$/);
  });

  it("no invocations today -> CPU metrics are 0", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      gql({}, { cpu: [], cpuHits: [] }),
    );
    const u = await usageFor({
      ...withToken("tok"),
      CF_ACCOUNT_ID: "acct-cpu-empty",
    });
    expect(u.metrics.slice(4)).toEqual([
      { key: "cpu_limit_hits", used: 0, limit: 0 },
      { key: "cpu_p99_ms", used: 0, limit: 10 },
    ]);
  });

  it("CPU data missing or malformed -> CPU metrics omitted, rest available", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      gql({}, { cpu: [{ quantiles: { cpuTimeP99: "x" } }], cpuHits: null }),
    );
    const u = await usageFor({
      ...withToken("tok"),
      CF_ACCOUNT_ID: "acct-cpu-bad",
    });
    expect(u.available).toBe(true);
    expect(u.metrics.map((m) => m.key)).toEqual([
      "requests",
      "d1_reads",
      "d1_writes",
      "do_requests",
    ]);
  });

  it("no WORKER_NAME -> no CPU aliases queried, CPU metrics omitted", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => gql());
    const u = await usageFor({
      ...withToken("tok"),
      WORKER_NAME: undefined,
      CF_ACCOUNT_ID: "acct-cpu-noname",
    });
    expect(u.metrics).toHaveLength(4);
    const init = graphqlCalls(spy)[0]?.[1] as RequestInit;
    expect(String(init.body)).not.toContain("cpuTimeP99");
  });
});

describe("MCP CPU-limit nudge", () => {
  const NUDGE = /hit Cloudflare's free-plan CPU limit (\d+) times today/;
  let pat: string;
  beforeAll(async () => {
    pat = (
      await createPat(
        env,
        (
          await login(`us-p-${newId().slice(0, 6).toLowerCase()}@x.com`)
        ).userId,
        "a",
      )
    ).token;
  });

  const listWith = async (hits: number, acct: string) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      gql({}, { cpuHits: [{ sum: { requests: hits } }] }),
    );
    await usageFor({ ...withToken("tok"), CF_ACCOUNT_ID: acct });
    vi.restoreAllMocks();
    const spy = vi.spyOn(globalThis, "fetch");
    const client = await connect(pat, { env: E(withToken("tok")) });
    const r = await tool(client, "list_artifacts", { scope: "mine" });
    await client.close();
    expect(graphqlCalls(spy)).toHaveLength(0);
    return r;
  };

  it("2 hits today -> no nudge", async () => {
    const r = await listWith(2, "acct-nudge-2");
    expect(textOf(r)).not.toMatch(NUDGE);
    expect(r.content).toHaveLength(1);
  });

  it("3 hits today -> one extra text item with N; structured content unchanged", async () => {
    const r = await listWith(3, "acct-nudge-3");
    expect(r.content).toHaveLength(2);
    expect(r.content[1]).toEqual({
      type: "text",
      text: "Your instance hit Cloudflare's free-plan CPU limit 3 times today. See Settings → Usage for the fix (Workers Paid).",
    });
    expect(r.structuredContent).not.toHaveProperty("cpu_limit_hits");
    expect(JSON.stringify(r.structuredContent)).not.toMatch(NUDGE);
  });
});
