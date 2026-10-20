import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index.js";

const A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const B = "b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const DASH = "d1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const TOKEN = "oat_super-secret-token";

const env = (over: Partial<Env> = {}): Env => ({
  DEMO_OA_TOKEN: TOKEN,
  DEMO_BASE_URL: "https://demo.example.test",
  DASHBOARD_ARTIFACT_ID: DASH,
  SOURCE_ARTIFACT_IDS: `${A},${B}`,
  ...over,
});

const tick = (e: Env) =>
  worker.scheduled({} as never, e, { waitUntil() {} } as never);

const stub = (
  sources: Record<string, unknown | "fail">,
): { calls: { url: string; method: string; body?: string }[] } => {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body as string | undefined });
      if (method === "PUT") return new Response("{}", { status: 200 });
      const id = url.split("/")[6] as string;
      const v = sources[id];
      if (v === undefined || v === "fail")
        return new Response("boom", { status: 500 });
      return Response.json(v);
    }),
  );
  return { calls };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("demo-ops tick", () => {
  it("reads only the listed ids and writes once to the dashboard", async () => {
    const { calls } = stub({ [A]: { items: [1, 2, 3] }, [B]: { items: [1] } });
    await tick(env());
    const gets = calls.filter((c) => c.method === "GET").map((c) => c.url);
    expect(gets.sort()).toEqual(
      [
        `https://demo.example.test/api/v1/artifacts/${A}/data`,
        `https://demo.example.test/api/v1/artifacts/${B}/data`,
      ].sort(),
    );
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toBe(
      `https://demo.example.test/api/v1/artifacts/${DASH}/data`,
    );
    const body = JSON.parse(puts[0]?.body as string);
    expect(body.counts).toEqual({ [A]: 3, [B]: 1 });
    expect(typeof body.updatedAt).toBe("string");
  });

  it("skips a failed source but still writes the others", async () => {
    const { calls } = stub({ [A]: "fail", [B]: { items: [1, 2] } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await tick(env());
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]?.body as string).counts).toEqual({ [B]: 2 });
  });

  it("validates every id before fetching and drops invalid ones", async () => {
    const { calls } = stub({ [A]: { items: [] } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await tick(
      env({ SOURCE_ARTIFACT_IDS: `${A},../x,${DASH}/../..,,not an id` }),
    );
    const gets = calls.filter((c) => c.method === "GET");
    expect(gets.map((c) => c.url)).toEqual([
      `https://demo.example.test/api/v1/artifacts/${A}/data`,
    ]);
  });

  it("refuses an invalid dashboard id without any fetch", async () => {
    const { calls } = stub({});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await tick(env({ DASHBOARD_ARTIFACT_ID: "../etc" }));
    expect(calls).toHaveLength(0);
  });

  it("sends the token as a bearer header and never logs it", async () => {
    const { calls } = stub({ [A]: "fail", [B]: { items: [] } });
    const logs: string[] = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      });
    await tick(env());
    expect(calls.length).toBeGreaterThan(0);
    for (const l of logs) expect(l).not.toContain(TOKEN);
    const f = vi.mocked(fetch);
    for (const [, init] of f.mock.calls)
      expect((init?.headers as Record<string, string>).authorization).toBe(
        `Bearer ${TOKEN}`,
      );
  });

  it("has no fetch handler that serves anything but 404", async () => {
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
  });
});
