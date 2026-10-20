import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env, MAX_REQUESTS, tick } from "../src/index.js";

const ID = (c: string) => `${c}1b2c3d4E5f6g7h8`;
const POLL = ID("P");
const CANVAS = ID("C");
const MAP = ID("M");
const TTT = ID("T");
const CHESS = ID("H");
const DASH = ID("D");
const BASE = "https://demo.example.test";
const TOKEN = "oat_super-secret-token";
const NOW = Date.UTC(2026, 9, 20, 13, 30, 0);
const DAY = "20261020";
const MIN = 60_000;

const env = (over: Partial<Env> = {}): Env => ({
  DEMO_OA_TOKEN: TOKEN,
  DEMO_BASE_URL: BASE,
  DASHBOARD_ARTIFACT_ID: DASH,
  POLL_ID: POLL,
  CANVAS_ID: CANVAS,
  MAP_ID: MAP,
  TICTACTOE_ID: TTT,
  CHESS_ID: CHESS,
  ...over,
});

type Doc = { id: string; data: unknown };
type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal | null;
};

/** An in-memory instance: collections per artifact, a count endpoint switch, failures. */
class World {
  cols = new Map<string, Doc[]>();
  count = false;
  fail = new Set<string>(); // path substrings that answer 500
  hang = new Set<string>(); // path substrings that never answer
  big = new Set<string>(); // path substrings that answer over 512 KB
  noAccess = new Set<string>(); // artifact ids that answer 404 to everything
  calls: Call[] = [];
  set(id: string, col: string, docs: Doc[]) {
    this.cols.set(`${id}/${col}`, docs);
  }
  doc(id: string, col: string, doc: string, data: unknown) {
    const k = `${id}/${col}`;
    this.cols.set(k, [...(this.cols.get(k) ?? []), { id: doc, data }]);
  }
  stat(name: string): unknown {
    return this.cols.get(`${DASH}/stats`)?.find((d) => d.id === name)?.data;
  }
  puts() {
    return this.calls.filter((c) => c.method === "PUT");
  }
  gets() {
    return this.calls.filter((c) => c.method === "GET");
  }
  install() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const u = new URL(String(input));
        const call: Call = {
          method: init?.method ?? "GET",
          path: u.pathname,
          query: u.searchParams,
          body: init?.body as string | undefined,
          headers: init?.headers as Record<string, string>,
          signal: init?.signal,
        };
        this.calls.push(call);
        for (const h of this.hang)
          if (u.pathname.includes(h))
            return new Promise<Response>((_, rej) =>
              init?.signal?.addEventListener("abort", () =>
                rej(new Error("aborted")),
              ),
            );
        for (const f of this.fail)
          if (u.pathname.includes(f))
            return new Response("boom", { status: 500 });
        for (const b of this.big)
          if (u.pathname.includes(b))
            return new Response("{}", {
              headers: { "content-length": String(600 * 1024) },
            });
        const cm = u.pathname.match(
          /^\/api\/v1\/artifacts\/([^/]+)\/data-count\/([^/]+)$/,
        );
        if (cm) {
          if (!this.count || this.noAccess.has(cm[1] as string))
            return new Response("nf", { status: 404 });
          return Response.json({
            count: this.cols.get(`${cm[1]}/${cm[2]}`)?.length ?? 0,
          });
        }
        const m = u.pathname.match(
          /^\/api\/v1\/artifacts\/([^/]+)\/data\/([^/]+)(?:\/([^/]+))?$/,
        );
        if (m && this.noAccess.has(m[1] as string))
          return new Response("nf", { status: 404 });
        if (!m) return new Response("nope", { status: 404 });
        const [, id, col, doc] = m as [
          string,
          string,
          string,
          string | undefined,
        ];
        const k = `${id}/${col}`;
        if (call.method === "PUT") {
          const list = this.cols.get(k) ?? [];
          this.cols.set(k, [
            ...list.filter((d) => d.id !== doc),
            { id: doc as string, data: JSON.parse(call.body as string) },
          ]);
          return Response.json({ ok: true });
        }
        const list = this.cols.get(k);
        if (doc) {
          const d = list?.find((x) => x.id === doc);
          return d
            ? Response.json({ id: d.id, data: d.data })
            : new Response("nf", { status: 404 });
        }
        if (!list) return Response.json({ items: [], nextCursor: null });
        const start = Number(call.query.get("cursor") ?? 0);
        const limit = Number(call.query.get("limit") ?? 25);
        const items = list.slice(start, start + limit);
        const next = start + limit < list.length ? String(start + limit) : null;
        return Response.json({ items, nextCursor: next });
      }),
    );
  }
}

const seat = (ago: number) => ({ id: "u", at: NOW - ago });
const full = (): World => {
  const w = new World();
  for (let i = 0; i < 7; i++) w.doc(POLL, `votes-${DAY}`, `v${i}`, { v: i });
  w.doc(CANVAS, `canvas-${DAY}`, "r00", { c0: 1, c1: 2, c2: 0 });
  w.doc(CANVAS, `canvas-${DAY}`, "r01", { c5: 1 });
  for (const c of ["US", "US", "FR", "xx", "DE"])
    w.doc(
      MAP,
      `pins-${DAY}`,
      `p${w.cols.get(`${MAP}/pins-${DAY}`)?.length ?? 0}`,
      { c },
    );
  w.doc(TTT, "game", "game", {
    board: "XO.X.....".split("").map((c) => (c === "." ? "" : c)),
    x: seat(MIN),
    o: seat(MIN),
  });
  w.doc(CHESS, "table", "table", {
    g: "g3",
    white: seat(MIN),
    black: seat(MIN),
  });
  w.doc(CHESS, "moves", "g3-001", {
    g: "g3",
    n: 1,
    m: "e4",
    by: "u",
    at: NOW - MIN,
  });
  w.doc(CHESS, "moves", "g3-002", {
    g: "g3",
    n: 2,
    m: "e5",
    by: "u",
    at: NOW - MIN,
  });
  w.doc(CHESS, "moves", "g2-001", {
    g: "g2",
    n: 1,
    m: "d4",
    by: "u",
    at: NOW - 99 * MIN,
  });
  return w;
};

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
  vi.useRealTimers();
});

const run = async (
  w: World,
  e: Env = env(),
  opts: { now?: number; budget?: number } = {},
) => {
  w.install();
  await tick(e, { now: NOW, ...opts });
};

describe("today", () => {
  it("writes every metric", async () => {
    const w = full();
    quiet();
    await run(w);
    expect(w.stat("today")).toEqual({
      day: DAY,
      updatedAt: NOW,
      votes: 7,
      gamesInProgress: { tictactoe: 1, chess: 1 },
      moves: { tictactoe: 3, chess: 2 },
      pixels: 3,
      countries: 3,
      pins: 5,
      truncated: [],
      missing: [],
      failed: [],
    });
  });

  it("writes one doc per call to stats/<doc>, never PUT /data", async () => {
    const w = full();
    await run(w);
    expect(
      w
        .puts()
        .map((c) => c.path)
        .sort(),
    ).toEqual([
      `/api/v1/artifacts/${DASH}/data/stats/hourly-${DAY}`,
      `/api/v1/artifacts/${DASH}/data/stats/today`,
    ]);
    for (const c of w.calls) expect(c.path).not.toMatch(/\/data$/);
  });

  it("unknown or missing docs count as 0, not errors", async () => {
    const w = new World();
    quiet();
    await run(w);
    expect(w.stat("today")).toMatchObject({
      votes: 0,
      pixels: 0,
      pins: 0,
      countries: 0,
      gamesInProgress: { tictactoe: 0, chess: 0 },
      moves: { tictactoe: 0, chess: 0 },
      failed: [],
    });
  });

  it("an empty id skips that source: value 0 and its name in missing", async () => {
    const w = full();
    quiet();
    await run(w, env({ POLL_ID: "", MAP_ID: "", CHESS_ID: "" }));
    const t = w.stat("today") as Record<string, unknown>;
    expect(t.votes).toBe(0);
    expect(t.pins).toBe(0);
    expect(t.countries).toBe(0);
    expect(t.missing).toEqual(["poll", "map", "chess"]);
    expect(
      w.calls.some(
        (c) =>
          c.path.includes(POLL) ||
          c.path.includes(MAP) ||
          c.path.includes(CHESS),
      ),
    ).toBe(false);
  });

  it("an invalid non-empty id is skipped and reported missing", async () => {
    const w = full();
    quiet();
    await run(w, env({ POLL_ID: "../x" }));
    expect((w.stat("today") as { missing: string[] }).missing).toEqual([
      "poll",
    ]);
    expect(w.calls.some((c) => c.path.includes(".."))).toBe(false);
  });

  it("an invalid dashboard id does nothing", async () => {
    const w = full();
    quiet();
    await run(w, env({ DASHBOARD_ARTIFACT_ID: "bad" }));
    expect(w.calls).toEqual([]);
  });

  it("a failing source is 0 and listed in failed; the others are still written", async () => {
    const w = full();
    w.fail.add(`/${POLL}/`);
    quiet();
    await run(w);
    const t = w.stat("today") as Record<string, unknown>;
    expect(t.votes).toBe(0);
    expect(t.failed).toEqual(["votes"]);
    expect(t.pixels).toBe(3);
  });
});

describe("counting", () => {
  it("uses the count endpoint when present (no listing of votes)", async () => {
    const w = full();
    w.count = true;
    await run(w);
    expect((w.stat("today") as { votes: number }).votes).toBe(7);
    expect(
      w.gets().some((c) => c.path.endsWith(`/data-count/votes-${DAY}`)),
    ).toBe(true);
    expect(w.gets().some((c) => c.path.endsWith(`/data/votes-${DAY}`))).toBe(
      false,
    );
  });

  it("falls back to paging when the count endpoint answers 404", async () => {
    const w = full();
    await run(w);
    expect((w.stat("today") as { votes: number }).votes).toBe(7);
    expect(
      w.gets().filter((c) => c.path.includes("/data-count/")),
    ).toHaveLength(2); // votes, pins
    expect(w.gets().some((c) => c.path.endsWith(`/data/votes-${DAY}`))).toBe(
      true,
    );
  });

  it("re-probes the count endpoint every tick (an absence is not cached)", async () => {
    const w = full();
    await run(w);
    await run(w);
    expect(
      w.gets().filter((c) => c.path.includes("/data-count/")),
    ).toHaveLength(4);
    w.count = true;
    const before = w.calls.length;
    await run(w);
    const t = w.stat("today") as { votes: number };
    expect(t.votes).toBe(7);
    expect(
      w.calls.slice(before).some((c) => c.path.endsWith(`/data/votes-${DAY}`)),
    ).toBe(false);
  });

  it("when count and paging both 404, the metric is missing (not a real 0), logged once", async () => {
    const w = full();
    w.noAccess.add(POLL);
    w.noAccess.add(MAP);
    const logs = quiet();
    await run(w);
    const t = w.stat("today") as {
      votes: number;
      pins: number;
      missing: string[];
      failed: string[];
    };
    expect(t.votes).toBe(0);
    expect(t.pins).toBe(0);
    expect([...t.missing].sort()).toEqual(["map", "poll"]);
    expect(t.failed).toEqual([]);
    expect(
      logs.filter((l) => l.includes("not found or no access")),
    ).toHaveLength(1);
    for (const l of logs) expect(l).not.toContain(TOKEN);
  });

  it("pages at most 2 x 200 and marks the metric truncated", async () => {
    const w = full();
    w.set(
      POLL,
      `votes-${DAY}`,
      Array.from({ length: 450 }, (_, i) => ({ id: `v${i}`, data: {} })),
    );
    await run(w);
    const t = w.stat("today") as { votes: number; truncated: string[] };
    expect(t.votes).toBe(400);
    expect(t.truncated).toEqual(["votes"]);
    expect(
      w.gets().filter((c) => c.path.endsWith(`/data/votes-${DAY}`)),
    ).toHaveLength(2);
  });

  it("with the count endpoint, votes are exact (not truncated) at any size", async () => {
    const w = full();
    w.count = true;
    w.set(
      POLL,
      `votes-${DAY}`,
      Array.from({ length: 450 }, (_, i) => ({ id: `v${i}`, data: {} })),
    );
    await run(w);
    const t = w.stat("today") as { votes: number; truncated: string[] };
    expect(t.votes).toBe(450);
    expect(t.truncated).not.toContain("votes");
  });

  it("countries and chess moves read at most 2 pages, then are truncated", async () => {
    const w = full();
    w.count = true;
    w.set(
      MAP,
      `pins-${DAY}`,
      Array.from({ length: 450 }, (_, i) => ({
        id: `p${i}`,
        data: { c: "US" },
      })),
    );
    w.set(
      CHESS,
      "moves",
      Array.from({ length: 450 }, (_, i) => ({
        id: `g3-${String(i).padStart(3, "0")}`,
        data: { at: NOW },
      })),
    );
    await run(w);
    const t = w.stat("today") as {
      pins: number;
      truncated: string[];
      moves: { chess: number };
    };
    expect(t.pins).toBe(450); // exact via the count endpoint
    expect(t.moves.chess).toBe(400);
    expect([...t.truncated].sort()).toEqual(["countries", "moves.chess"]);
  });

  it("an over-512 KB page marks truncated instead of hiding the source", async () => {
    const w = full();
    w.big.add(`/${MAP}/data/pins-`);
    quiet();
    await run(w);
    const t = w.stat("today") as { truncated: string[]; failed: string[] };
    expect(t.truncated).toContain("countries");
    expect(t.failed).toEqual([]);
  });
});

describe("hourly", () => {
  const hourly = (w: World) =>
    w.stat(`hourly-${DAY}`) as {
      h: number[];
      lastTotal: number;
      lastDay: string;
    };

  it("the first tick is a baseline; later ticks add the change in writes to the current hour", async () => {
    const w = full();
    await run(w);
    // votes 7 + ttt moves 3 + chess moves 2 + pixels 3 + pins 5
    expect(hourly(w)).toEqual({
      h: Array(24).fill(0),
      lastTotal: 20,
      lastDay: DAY,
    });
    w.doc(POLL, `votes-${DAY}`, "v99", {});
    w.doc(MAP, `pins-${DAY}`, "p99", { c: "ES" });
    await run(w);
    expect(hourly(w).h[13]).toBe(2);
    expect(hourly(w).lastTotal).toBe(22);
    w.doc(POLL, `votes-${DAY}`, "v100", {});
    await run(w);
    expect(hourly(w).h[13]).toBe(3);
  });

  it("goes to the hour of 'now'", async () => {
    const w = full();
    await run(w, env(), { now: Date.UTC(2026, 9, 20, 5, 0, 0) });
    w.doc(POLL, `votes-${DAY}`, "v99", {});
    await run(w, env(), { now: Date.UTC(2026, 9, 20, 5, 59, 0) });
    expect(hourly(w).h[5]).toBe(1);
  });

  it("clamps a negative delta to 0 and moves the baseline", async () => {
    const w = full();
    await run(w);
    w.set(POLL, `votes-${DAY}`, []); // 7 votes vanish (a reset)
    await run(w);
    expect(hourly(w).h.reduce((a, b) => a + b, 0)).toBe(0);
    expect(hourly(w).lastTotal).toBe(13);
    w.doc(POLL, `votes-${DAY}`, "v1", {});
    await run(w);
    expect(hourly(w).h[13]).toBe(1);
  });

  it("starts a fresh doc on a new day", async () => {
    const w = full();
    await run(w);
    const next = Date.UTC(2026, 9, 21, 0, 1, 0);
    w.doc(POLL, "votes-20261021", "v1", {});
    await run(w, env(), { now: next });
    const t = w.stat("today") as { day: string; votes: number };
    expect(t.day).toBe("20261021");
    expect(t.votes).toBe(1);
    expect(w.stat("hourly-20261021")).toMatchObject({ lastDay: "20261021" });
    expect(
      (w.stat("hourly-20261021") as { h: number[] }).h.reduce(
        (a, b) => a + b,
        0,
      ),
    ).toBe(0);
    // yesterday's doc is left alone
    expect(hourly(w).lastDay).toBe(DAY);
  });

  it("is not updated when a source failed (no spurious spike on recovery)", async () => {
    const w = full();
    await run(w);
    const before = JSON.stringify(hourly(w));
    w.fail.add(`/${POLL}/`);
    quiet();
    await run(w);
    expect(JSON.stringify(hourly(w))).toBe(before);
    w.fail.clear();
    await run(w);
    expect(hourly(w).h.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("budget, deadline and limits", () => {
  it("the request budget is 45", () => {
    expect(MAX_REQUESTS).toBe(45);
  });

  it("never exceeds the budget, and still writes today (hourly waits for a clean tick)", async () => {
    const w = full();
    quiet();
    await run(w, env(), { budget: 6 });
    expect(w.calls.length).toBeLessThanOrEqual(6);
    expect(w.puts().map((c) => c.path.split("/").pop())).toEqual(["today"]);
    const t = w.stat("today") as { failed: string[] };
    expect(t.failed.length).toBeGreaterThan(0);
  });

  it("a normal tick stays far below 45 requests", async () => {
    const w = full();
    await run(w);
    expect(w.calls.length).toBeLessThan(MAX_REQUESTS);
  });

  it("past the 40 s deadline it skips the rest and still writes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = full();
    w.hang.add(`/${POLL}/`);
    quiet();
    w.install();
    const done = tick(env(), { now: NOW });
    await vi.advanceTimersByTimeAsync(40_000);
    await done;
    const t = w.stat("today") as { failed: string[]; pixels: number };
    expect(t.failed).toContain("votes");
    // later metrics were skipped after the deadline: not fetched
    expect(w.gets().some((c) => c.path.includes(CANVAS))).toBe(false);
    expect(t.pixels).toBe(0);
    expect(w.puts().length).toBeGreaterThanOrEqual(1);
  });

  it("puts a 5 s timeout signal on every fetch", async () => {
    const w = full();
    await run(w);
    for (const c of w.calls) expect(c.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("secrets and handlers", () => {
  it("sends the token as a bearer header and never logs it", async () => {
    const w = full();
    w.fail.add(`/${POLL}/`);
    const logs = quiet();
    await run(w);
    for (const l of logs) expect(l).not.toContain(TOKEN);
    for (const c of w.calls)
      expect(c.headers?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("scheduled() runs a tick with the real clock", async () => {
    const w = full();
    w.install();
    await worker.scheduled({} as never, env(), { waitUntil() {} } as never);
    expect(w.puts().length).toBe(2);
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
  it("is private, minutely, and has the v2 vars only", () => {
    expect(cfg.name).toBe("open-artifacts-demo-ops");
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.routes).toBeUndefined();
    expect(cfg.triggers.crons).toEqual(["* * * * *"]);
    expect(Object.keys(cfg.vars).sort()).toEqual(
      [
        "CANVAS_ID",
        "CHESS_ID",
        "DASHBOARD_ARTIFACT_ID",
        "DEMO_BASE_URL",
        "MAP_ID",
        "POLL_ID",
        "TICTACTOE_ID",
      ].sort(),
    );
  });
});
