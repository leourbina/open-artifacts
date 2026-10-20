import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index.js";

const A = "A1b2c3d4E5f6g7h8";
const B = "B1b2c3d4E5f6g7h8";
const DASH = "D1b2c3d4E5f6g7h8";
const BASE = "https://demo.example.test";
const TOKEN = "oat_super-secret-token";

const env = (over: Partial<Env> = {}): Env => ({
  DEMO_OA_TOKEN: TOKEN,
  DEMO_BASE_URL: BASE,
  DASHBOARD_ARTIFACT_ID: DASH,
  SOURCE_ARTIFACT_IDS: `${A},${B}`,
  SOURCE_COLLECTIONS: "events",
  ...over,
});

const tick = (e: Env) =>
  worker.scheduled({} as never, e, { waitUntil() {} } as never);

type Call = {
  url: string;
  method: string;
  body?: string;
  signal?: AbortSignal | null;
  headers?: Record<string, string>;
};
type Handler = (url: URL, call: Call) => Response | undefined;

const stub = (h: Handler): { calls: Call[] } => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body as string | undefined,
        signal: init?.signal,
        headers: init?.headers as Record<string, string>,
      };
      calls.push(call);
      if (call.method === "PUT") return new Response("{}", { status: 200 });
      return (
        h(new URL(call.url), call) ?? new Response("boom", { status: 500 })
      );
    }),
  );
  return { calls };
};

const page = (n: number, nextCursor: string | null = null) =>
  Response.json({
    items: Array.from({ length: n }, (_, i) => ({ id: `d${i}`, data: {} })),
    nextCursor,
  });
const idOf = (u: URL) => u.pathname.split("/")[4] as string;
const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");
const quiet = () => {
  const logs: string[] = [];
  for (const m of ["log", "warn", "error", "info", "debug"] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  return logs;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("demo-ops tick", () => {
  it("reads only the listed ids and collections, paged, and writes once to stats/summary", async () => {
    const { calls } = stub((u) => (idOf(u) === A ? page(3) : page(1)));
    await tick(env());
    const gets = calls.filter((c) => c.method === "GET").map((c) => c.url);
    expect(gets.sort()).toEqual(
      [
        `${BASE}/api/v1/artifacts/${A}/data/events?limit=200`,
        `${BASE}/api/v1/artifacts/${B}/data/events?limit=200`,
      ].sort(),
    );
    const w = puts(calls);
    expect(w).toHaveLength(1);
    expect(w[0]?.url).toBe(
      `${BASE}/api/v1/artifacts/${DASH}/data/stats/summary`,
    );
    const body = JSON.parse(w[0]?.body as string);
    expect(body.counts).toEqual({ [A]: 3, [B]: 1 });
    expect(typeof body.updatedAt).toBe("string");
  });

  it("never calls the atomic reset PUT /data", async () => {
    const { calls } = stub(() => page(1));
    await tick(env());
    for (const c of calls)
      expect(new URL(c.url).pathname).not.toMatch(/\/data$/);
  });

  it("caps at 2 pages of 200 per collection", async () => {
    const { calls } = stub((u) =>
      page(200, u.searchParams.get("cursor") === "c2" ? "c3" : "c2"),
    );
    await tick(env({ SOURCE_ARTIFACT_IDS: A }));
    const gets = calls.filter((c) => c.method === "GET");
    expect(gets).toHaveLength(2);
    expect(gets[1]?.url).toContain("cursor=c2");
    expect(JSON.parse(puts(calls)[0]?.body as string).counts[A]).toBe(400);
  });

  it("skips a failed source but still writes the others", async () => {
    const { calls } = stub((u) => (idOf(u) === A ? undefined : page(2)));
    quiet();
    await tick(env());
    expect(puts(calls)).toHaveLength(1);
    expect(JSON.parse(puts(calls)[0]?.body as string).counts).toEqual({
      [B]: 2,
    });
  });

  it("validates ids with isId and collection names before fetching", async () => {
    const { calls } = stub(() => page(1));
    quiet();
    await tick(
      env({
        SOURCE_ARTIFACT_IDS: `${A},../x,${DASH}/../..,,not an id,l0O0l0O0l0O0l0O0`,
        SOURCE_COLLECTIONS: "events,../x,bad name",
      }),
    );
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([
      `${BASE}/api/v1/artifacts/${A}/data/events?limit=200`,
    ]);
  });

  it("caps ids at 10 and collections at 5", async () => {
    const ids = Array.from(
      { length: 14 },
      (_, i) => `${String.fromCharCode(65 + i)}1b2c3d4E5f6g7h8`,
    );
    const { calls } = stub(() => page(0));
    await tick(
      env({
        SOURCE_ARTIFACT_IDS: ids.join(","),
        SOURCE_COLLECTIONS: "c1,c2,c3,c4,c5,c6,c7",
      }),
    );
    const gets = calls.filter((c) => c.method === "GET");
    expect(gets).toHaveLength(10 * 5);
    expect(new Set(gets.map((c) => idOf(new URL(c.url)))).size).toBe(10);
  });

  it("is a silent no-op with no ids or no collections", async () => {
    const { calls } = stub(() => page(1));
    const logs = quiet();
    await tick(env({ SOURCE_ARTIFACT_IDS: " , " }));
    await tick(env({ SOURCE_COLLECTIONS: "" }));
    expect(calls).toHaveLength(0);
    expect(logs).toEqual([]);
  });

  it("refuses an invalid dashboard id without any fetch", async () => {
    const { calls } = stub(() => page(1));
    quiet();
    await tick(env({ DASHBOARD_ARTIFACT_ID: "../etc" }));
    expect(calls).toHaveLength(0);
  });

  it("puts a 5 s timeout signal on every fetch", async () => {
    const { calls } = stub(() => page(1));
    await tick(env());
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.signal).toBeInstanceOf(AbortSignal);
  });

  it("skips a response over 512 KB, by content-length or by reading", async () => {
    const { calls } = stub((u) => {
      if (idOf(u) === A)
        return new Response("{}", {
          headers: { "content-length": String(600 * 1024) },
        });
      return new Response(
        JSON.stringify({
          items: [],
          nextCursor: null,
          pad: "x".repeat(600 * 1024),
        }),
      );
    });
    quiet();
    await tick(env({ SOURCE_ARTIFACT_IDS: `${A},${B}` }));
    expect(JSON.parse(puts(calls)[0]?.body as string).counts).toEqual({});
  });

  it("sends the token as a bearer header and never logs it", async () => {
    const { calls } = stub((u) => (idOf(u) === A ? undefined : page(1)));
    const logs = quiet();
    await tick(env());
    for (const l of logs) expect(l).not.toContain(TOKEN);
    for (const c of calls)
      expect(c.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("has a fetch handler that only serves 404", async () => {
    const res = await (
      worker as unknown as { fetch?: (r: Request) => Response }
    ).fetch?.(new Request("https://x.test/"));
    expect(res?.status).toBe(404);
  });
});

describe("wrangler.jsonc", () => {
  const cfg = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  it("is private: no workers.dev, no routes, a minutely cron", () => {
    expect(cfg.name).toBe("open-artifacts-demo-ops");
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.routes).toBeUndefined();
    expect(cfg.triggers.crons).toEqual(["* * * * *"]);
    expect(Object.keys(cfg.vars)).toContain("SOURCE_COLLECTIONS");
  });
});
