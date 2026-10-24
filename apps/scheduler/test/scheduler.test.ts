import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import scheduler, { CRON, type Env, runNightly } from "../src/index.js";

// P1 Task 7 (Review Focus 5): one install's nightly job throwing or timing
// out must not stop the others. PLATFORM_DB is a local D1 with the real
// platform migrations; DISPATCHER is a fake that records every script asked
// for and each scheduled() call.

const db = (testEnv as unknown as { PLATFORM_DB: D1Database }).PLATFORM_DB;

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});

beforeEach(async () => {
  await db.prepare("DELETE FROM installs").run();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type State = "creating" | "active" | "upgrading" | "deleting" | "deleted";

/** A valid install id for n: "i" + 11 base32-ish chars. */
const idOf = (n: number) => `i${n.toString(36).padStart(11, "0")}`;

async function seed(rows: { id: string; state: State }[]) {
  const ins = db.prepare(
    `INSERT INTO installs (id, slug, app_host, content_host, owner_email, rl_ns,
       inputs_hash, state, created_at, updated_at)
     VALUES (?1, ?2, ?2 || '.app.test', ?2 || '.content.test', ?3, ?4, 'h', ?5, 0, 0)`,
  );
  const stmts = rows.map((r, i) =>
    ins.bind(r.id, `s${i}`, `owner${i}@customer.test`, (i + 1) * 8, r.state),
  );
  for (let i = 0; i < stmts.length; i += 100)
    await db.batch(stmts.slice(i, i + 100));
}

type Behavior =
  | "ok"
  | "throw"
  | "hang"
  | "outcome"
  | "canceled"
  | "missing"
  | { result: unknown };

function fakes(
  oaEnv: "staging" | "prod" = "staging",
  behave: (script: string) => Behavior = () => "ok",
  delayMs = 0,
) {
  const scripts: string[] = [];
  const calls: { script: string; opts: unknown }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const env = {
    OA_ENV: oaEnv,
    PLATFORM_DB: db,
    DISPATCHER: {
      get(script: string) {
        scripts.push(script);
        const b = behave(script);
        if (b === "missing")
          throw new Error(`Worker not found: ${script} owner@customer.test`);
        return {
          async scheduled(opts: unknown) {
            calls.push({ script, opts });
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
              if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
              if (b === "hang") await new Promise(() => {});
              if (b === "throw")
                throw new Error("boom for owner@customer.test SECRET=x");
              if (typeof b === "object") return b.result;
              if (b === "outcome")
                return { outcome: "exception", noRetry: false };
              if (b === "canceled")
                return { outcome: "canceled", noRetry: false };
              return { outcome: "ok", noRetry: false };
            } finally {
              inFlight--;
            }
          },
        };
      },
    },
  } as unknown as Env;
  return { env, scripts, calls, max: () => maxInFlight };
}

function captureLogs() {
  const lines: string[] = [];
  const rec = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(rec);
  vi.spyOn(console, "warn").mockImplementation(rec);
  vi.spyOn(console, "error").mockImplementation(rec);
  vi.spyOn(console, "info").mockImplementation(rec);
  return lines;
}

const NOW = Date.UTC(2026, 9, 24, 3, 17);

/** The whole log vocabulary: install ids, fixed categories and counts. */
const LOG_LINE =
  /^(?:nightly failed (?:timeout|not_found|canceled|exception) i[a-z0-9]{11}|nightly summary active=\d+ ok=\d+ failed=\d+|nightly invalid ids=\d+|nightly scale active=\d+ over 300)$/;

describe("runNightly", () => {
  it("runs every active install and skips creating, upgrading and deleting ones", async () => {
    const states: State[] = [
      "creating",
      "active",
      "upgrading",
      "active",
      "deleting",
      "deleted",
      "active",
    ];
    await seed(states.map((state, i) => ({ id: idOf(i), state })));
    const f = fakes();
    const r = await runNightly(f.env, NOW);
    const active = [idOf(1), idOf(3), idOf(6)];
    expect([...r.ok].sort()).toEqual(active);
    expect(r.failed).toEqual([]);
    expect([...f.scripts].sort()).toEqual(active.map((id) => `oa-s-${id}`));
    for (const c of f.calls)
      expect(c.opts).toEqual({
        cron: "17 3 * * *",
        scheduledTime: new Date(NOW),
      });
    expect(CRON).toBe("17 3 * * *");
  });

  it("one install throwing or timing out doesn't stop the others; it's reported in failed", async () => {
    await seed(
      [0, 1, 2, 3, 4, 5].map((n) => ({ id: idOf(n), state: "active" })),
    );
    const by: Record<string, Behavior> = {
      [`oa-s-${idOf(1)}`]: "throw",
      [`oa-s-${idOf(2)}`]: "hang",
      [`oa-s-${idOf(3)}`]: "missing",
      [`oa-s-${idOf(4)}`]: "outcome",
    };
    const f = fakes("staging", (s) => by[s] ?? "ok");
    const r = await runNightly(f.env, NOW, { concurrency: 2, timeoutMs: 30 });
    expect([...r.ok].sort()).toEqual([idOf(0), idOf(5)]);
    expect([...r.failed].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: idOf(1), reason: "exception" },
      { id: idOf(2), reason: "timeout" },
      { id: idOf(3), reason: "not_found" },
      { id: idOf(4), reason: "exception" },
    ]);
    // Reasons are fixed categories, never error text.
    for (const x of r.failed)
      expect(["timeout", "not_found", "exception"]).toContain(x.reason);
  });

  it('fails closed on the result: only outcome "ok" is ok', async () => {
    const results: Behavior[] = [
      "ok",
      "outcome",
      "canceled",
      { result: undefined },
      { result: null },
      { result: {} },
      { result: { outcome: "OK", noRetry: false } },
      { result: { outcome: 1, noRetry: false } },
      { result: "ok" },
    ];
    await seed(results.map((_, n) => ({ id: idOf(n), state: "active" })));
    const f = fakes(
      "staging",
      (s) => results[Number.parseInt(s.slice(-11), 36)] as Behavior,
    );
    const r = await runNightly(f.env, NOW);
    expect(r.ok).toEqual([idOf(0)]);
    expect([...r.failed].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: idOf(1), reason: "exception" },
      { id: idOf(2), reason: "canceled" },
      ...[3, 4, 5, 6, 7, 8].map((n) => ({ id: idOf(n), reason: "exception" })),
    ]);
  });

  it("the timeout is real: a never-resolving install fails at timeoutMs (default 25 s)", async () => {
    await seed([{ id: idOf(0), state: "active" }]);
    const f = fakes("staging", () => "hang");
    vi.useFakeTimers();
    let done: Awaited<ReturnType<typeof runNightly>> | undefined;
    const p = runNightly(f.env, NOW).then((r) => {
      done = r;
    });
    // Let the D1 read and the call start before moving the clock (vi.waitFor
    // would advance the fake clock itself; a D1 round trip is real I/O).
    for (let k = 0; k < 100 && f.calls.length === 0; k++)
      await db.prepare("SELECT 1").first();
    expect(f.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toEqual({
      ok: [],
      failed: [{ id: idOf(0), reason: "timeout" }],
    });
  });

  it("respects the concurrency limit (max in flight observed <= 10)", async () => {
    await seed(
      Array.from({ length: 35 }, (_, n) => ({ id: idOf(n), state: "active" })),
    );
    const f = fakes("staging", () => "ok", 5);
    const r = await runNightly(f.env, NOW);
    expect(r.ok).toHaveLength(35);
    expect(f.max()).toBeLessThanOrEqual(10);
    expect(f.max()).toBe(10);
  });

  it("respects a concurrency limit of 3", async () => {
    await seed(
      Array.from({ length: 12 }, (_, n) => ({ id: idOf(n), state: "active" })),
    );
    const f = fakes("staging", () => "ok", 5);
    const r = await runNightly(f.env, NOW, { concurrency: 3 });
    expect(r.ok).toHaveLength(12);
    expect(f.max()).toBe(3);
  });

  it("zero installs is a no-op", async () => {
    await seed([{ id: idOf(0), state: "creating" }]);
    const f = fakes();
    expect(await runNightly(f.env, NOW)).toEqual({ ok: [], failed: [] });
    expect(f.scripts).toEqual([]);
  });

  it("an invalid id in the DB is skipped with no call", async () => {
    await seed([
      { id: idOf(0), state: "active" },
      { id: "../oa-p-other", state: "active" },
      { id: "IABC123DEF45", state: "active" },
      { id: "iabc123def45x", state: "active" },
    ]);
    const lines = captureLogs();
    const f = fakes();
    const r = await runNightly(f.env, NOW);
    expect(r).toEqual({ ok: [idOf(0)], failed: [] });
    // A count only: the bad value itself is never logged.
    expect(lines).toEqual(["nightly invalid ids=3"]);
    expect(f.scripts).toEqual([`oa-s-${idOf(0)}`]);
  });

  it("uses the env prefix of OA_ENV", async () => {
    await seed([{ id: idOf(7), state: "active" }]);
    const p = fakes("prod");
    await runNightly(p.env, NOW);
    expect(p.scripts).toEqual([`oa-p-${idOf(7)}`]);
    const s = fakes("staging");
    await runNightly(s.env, NOW);
    expect(s.scripts).toEqual([`oa-s-${idOf(7)}`]);
  });

  it("an unknown OA_ENV calls nothing", async () => {
    await seed([{ id: idOf(0), state: "active" }]);
    const f = fakes("dev" as "prod");
    await expect(runNightly(f.env, NOW)).rejects.toThrow();
    expect(f.scripts).toEqual([]);
  });

  it("pages through the installs table, each active install once", async () => {
    await seed(
      Array.from({ length: 23 }, (_, n) => ({
        id: idOf(n),
        state: n % 5 === 0 ? "upgrading" : "active",
      })),
    );
    const f = fakes();
    const r = await runNightly(f.env, NOW, { pageSize: 4 });
    const want = Array.from({ length: 23 }, (_, n) => n)
      .filter((n) => n % 5 !== 0)
      .map(idOf);
    expect([...r.ok].sort()).toEqual(want);
    expect(new Set(f.scripts).size).toBe(f.scripts.length);
  });

  it("more than 300 active installs logs the scale warning", async () => {
    await seed(
      Array.from({ length: 301 }, (_, n) => ({ id: idOf(n), state: "active" })),
    );
    const lines = captureLogs();
    const f = fakes();
    const r = await runNightly(f.env, NOW, { concurrency: 50 });
    expect(r.ok).toHaveLength(301);
    expect(lines.filter((l) => l.startsWith("nightly scale"))).toEqual([
      "nightly scale active=301 over 300",
    ]);
  });

  it("300 active installs logs no scale warning", async () => {
    await seed(
      Array.from({ length: 300 }, (_, n) => ({ id: idOf(n), state: "active" })),
    );
    const lines = captureLogs();
    await runNightly(fakes().env, NOW, { concurrency: 50 });
    expect(lines.some((l) => l.startsWith("nightly scale"))).toBe(false);
  });
});

describe("scheduled", () => {
  const controller = (scheduledTime: number) =>
    ({ scheduledTime, cron: CRON, noRetry() {} }) as ScheduledController;

  it("runs with event.scheduledTime and logs one line per failure and one summary, no error text or PII", async () => {
    await seed([
      { id: idOf(0), state: "active" },
      { id: idOf(1), state: "active" },
      { id: idOf(2), state: "active" },
      { id: "not-an-id", state: "active" },
      { id: idOf(3), state: "creating" },
    ]);
    const lines = captureLogs();
    const by: Record<string, Behavior> = {
      [`oa-s-${idOf(1)}`]: "throw",
      [`oa-s-${idOf(2)}`]: "missing",
    };
    const f = fakes("staging", (s) => by[s] ?? "ok");
    await scheduler.scheduled(
      controller(1234),
      f.env,
      createExecutionContext(),
    );
    // The missing script never gets a call; the throwing one does.
    expect(f.calls.map((c) => c.opts)).toEqual([
      { cron: CRON, scheduledTime: new Date(1234) },
      { cron: CRON, scheduledTime: new Date(1234) },
    ]);
    expect([...lines].sort()).toEqual(
      [
        `nightly failed exception ${idOf(1)}`,
        `nightly failed not_found ${idOf(2)}`,
        "nightly invalid ids=1",
        "nightly summary active=3 ok=1 failed=2",
      ].sort(),
    );
    // Every line is ids, fixed categories and counts only.
    for (const l of lines) expect(l).toMatch(LOG_LINE);
    const all = lines.join("\n");
    expect(all).not.toMatch(/@|boom|SECRET|Worker not found|not-an-id|oa-s-/);
  });

  it("logs nothing but ids, categories and counts, whatever the installs do", async () => {
    const kinds: Behavior[] = [
      "ok",
      "throw",
      "hang",
      "outcome",
      "canceled",
      "missing",
      { result: undefined },
    ];
    await seed([
      ...Array.from({ length: 301 }, (_, n) => ({
        id: idOf(n),
        state: "active" as State,
      })),
      { id: "x@customer.test", state: "active" },
    ]);
    const lines = captureLogs();
    const f = fakes(
      "staging",
      (s) =>
        kinds[Number.parseInt(s.slice(-11), 36) % kinds.length] as Behavior,
    );
    const { ok, failed } = await runNightly(f.env, NOW, {
      concurrency: 50,
      timeoutMs: 20,
    });
    for (const x of failed) console.error("nightly failed", x.reason, x.id);
    await scheduler.scheduled(
      controller(NOW),
      fakes("prod").env,
      createExecutionContext(),
    );
    expect(ok.length + failed.length).toBe(301);
    expect(lines.length).toBeGreaterThan(failed.length);
    for (const l of lines) expect(l).toMatch(LOG_LINE);
  });

  it("zero installs logs only the summary", async () => {
    const lines = captureLogs();
    const f = fakes();
    await scheduler.scheduled(controller(NOW), f.env, createExecutionContext());
    expect(lines).toEqual(["nightly summary active=0 ok=0 failed=0"]);
    expect(f.scripts).toEqual([]);
  });
});
