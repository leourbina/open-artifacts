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
import scheduler, {
  CRON,
  type Env,
  nightly,
  runNightly,
} from "../src/index.js";

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

async function seed(rows: { id: string; state: State; leaseUntil?: number }[]) {
  const ins = db.prepare(
    `INSERT INTO installs (id, slug, app_host, content_host, owner_email, rl_ns,
       inputs_hash, state, created_at, updated_at, lease_until)
     VALUES (?1, ?2, ?2 || '.app.test', ?2 || '.content.test', ?3, ?4, 'h', ?5, 0, 0, ?6)`,
  );
  const stmts = rows.map((r, i) =>
    ins.bind(
      r.id,
      `s${i}`,
      `owner${i}@customer.test`,
      (i + 1) * 8,
      r.state,
      r.leaseUntil ?? null,
    ),
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
  | "scriptNotFound"
  | { result: unknown };

const n36 = (script: string) => Number.parseInt(script.slice(-11), 36);

function fakes(
  oaEnv: "staging" | "prod" = "staging",
  behave: (script: string) => Behavior = () => "ok",
  delayMs = 0,
  onCall: (script: string) => Promise<void> | void = () => {},
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
        // Lazy, like the real binding: a missing script fails on the call.
        scripts.push(script);
        const b = behave(script);
        return {
          async scheduled(opts: unknown) {
            calls.push({ script, opts });
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
              await onCall(script);
              if (b === "missing")
                throw new Error(
                  `Worker not found: ${script} owner@customer.test`,
                );
              if (b === "scriptNotFound")
                return { outcome: "scriptNotFound", noRetry: true };
              if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
              if (b === "hang") await new Promise(() => {});
              if (b === "throw")
                throw new Error(
                  "boom for owner@customer.test at https://acme.open-artifacts.app/c/123.sig/x SECRET=x",
                );
              if (typeof b === "object") return b.result;
              if (b === "outcome")
                return { outcome: "exception", noRetry: false };
              if (b === "canceled")
                return { outcome: "canceled", noRetry: false };
              // Measured on staging: a handler that succeeds resolves to
              // undefined; one that throws rejects with its own error.
              return undefined;
            } finally {
              inFlight--;
            }
          },
        };
      },
    },
  } as unknown as Env;
  return {
    env,
    scripts,
    calls,
    max: () => maxInFlight,
    inFlight: () => inFlight,
  };
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
  /^(?:nightly failed (?:timeout|not_found|canceled|exception) i[a-z0-9]{11}|nightly skipped (?:state|deadline|recheck|db_error) i[a-z0-9]{11}|nightly db_error i[a-z0-9]{11}|nightly leaked i[a-z0-9]{11}|nightly summary active=\d+ ok=\d+ failed=\d+ skipped=\d+ db_errors=\d+ leaked=\d+|nightly invalid ids=\d+|nightly scale active=\d+ over 300|nightly aborted (?:env|exception))$/;

const DAY = 86_400_000;
const NONE = { dbErrors: [], leaked: [] };

/** PLATFORM_DB with the per-call re-check (only) replaced for some ids. */
function recheckDb(
  behave: (id: string) => "ok" | "throw" | "stall",
): D1Database {
  return new Proxy(db, {
    get(t, k) {
      if (k !== "prepare") return Reflect.get(t, k);
      return (sql: string) => {
        const st = t.prepare(sql);
        if (!sql.startsWith("SELECT 1 AS ok")) return st;
        return {
          bind: (id: string, ...rest: unknown[]) => {
            const b = behave(id);
            const real = st.bind(id, ...rest);
            return {
              first: () =>
                b === "throw"
                  ? Promise.reject(new Error(`D1_ERROR for ${id}`))
                  : b === "stall"
                    ? new Promise(() => {})
                    : real.first(),
            };
          },
        };
      };
    },
  }) as D1Database;
}

const ids = (n: number, state: State = "active") =>
  Array.from({ length: n }, (_, k) => ({ id: idOf(k), state }));

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    expect(r.skipped).toEqual([]);
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
    expect(r.skipped).toEqual([]);
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

  it('resolving is ok (undefined or outcome "ok"); any other result fails closed', async () => {
    const results: Behavior[] = [
      "ok",
      "outcome",
      "canceled",
      { result: { outcome: "ok", noRetry: false } },
      { result: null },
      { result: {} },
      { result: { outcome: "OK", noRetry: false } },
      { result: { outcome: 1, noRetry: false } },
      { result: "ok" },
      "scriptNotFound",
      { result: { outcome: "exceededCpu", noRetry: false } },
    ];
    await seed(results.map((_, n) => ({ id: idOf(n), state: "active" })));
    const f = fakes(
      "staging",
      (s) => results[Number.parseInt(s.slice(-11), 36)] as Behavior,
    );
    const r = await runNightly(f.env, NOW);
    expect(r.ok).toEqual([idOf(0), idOf(3)]);
    expect([...r.failed].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: idOf(1), reason: "exception" },
      { id: idOf(2), reason: "canceled" },
      ...[4, 5, 6, 7, 8].map((n) => ({ id: idOf(n), reason: "exception" })),
      { id: idOf(9), reason: "not_found" },
      { id: idOf(10), reason: "exception" },
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
      skipped: [],
      ...NONE,
    });
  });

  it("respects the concurrency limit (default 6: the shared connection limit)", async () => {
    await seed(ids(35));
    const f = fakes("staging", () => "ok", 5);
    const r = await runNightly(f.env, NOW);
    expect(r.ok).toHaveLength(35);
    expect(f.max()).toBeLessThanOrEqual(6);
    expect(f.max()).toBe(6);
  });

  it("a timed-out call keeps its lane until it settles: never-settling installs can't over-subscribe", async () => {
    await seed(ids(10));
    const f = fakes("staging", () => "hang");
    const r = await runNightly(f.env, NOW, {
      concurrency: 3,
      timeoutMs: 20,
      deadlineMs: 300,
    });
    // Three calls hold the three lanes forever; nothing else is started.
    expect(f.calls).toHaveLength(3);
    expect(f.max()).toBe(3);
    expect(r.failed).toEqual(
      [0, 1, 2].map((n) => ({ id: idOf(n), reason: "timeout" })),
    );
    expect(r.ok).toEqual([]);
    expect(r.skipped).toEqual([3, 4, 5, 6, 7, 8, 9].map(idOf));
  });

  it("timed-out calls still count against the cap while the others run", async () => {
    await seed(ids(12));
    const f = fakes("staging", (s) => (n36(s) < 2 ? "hang" : "ok"), 5);
    const r = await runNightly(f.env, NOW, { concurrency: 3, timeoutMs: 20 });
    expect(f.max()).toBe(3);
    expect(r.failed).toEqual([
      { id: idOf(0), reason: "timeout" },
      { id: idOf(1), reason: "timeout" },
    ]);
    expect(r.ok).toHaveLength(10);
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
    expect(await runNightly(f.env, NOW)).toEqual({
      ok: [],
      failed: [],
      skipped: [],
      ...NONE,
    });
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
    expect(r).toEqual({ ok: [idOf(0)], failed: [], skipped: [], ...NONE });
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

  it("pages through an exact multiple of the page size (empty last page)", async () => {
    await seed(ids(8));
    const f = fakes();
    const r = await runNightly(f.env, NOW, { pageSize: 4 });
    expect([...r.ok].sort()).toEqual(ids(8).map((x) => x.id));
    expect(f.scripts).toHaveLength(8);
  });

  it("re-checks each install right before its call: one that left active or took a lease is skipped", async () => {
    await seed(ids(5));
    const flipped = async (script: string) => {
      if (script !== `oa-s-${idOf(0)}`) return;
      await db
        .prepare("UPDATE installs SET state = 'upgrading' WHERE id = ?")
        .bind(idOf(1))
        .run();
      await db
        .prepare("UPDATE installs SET state = 'deleting' WHERE id = ?")
        .bind(idOf(2))
        .run();
      await db
        .prepare("UPDATE installs SET lease_until = ? WHERE id = ?")
        .bind(Date.now() + 60_000, idOf(3))
        .run();
    };
    const lines = captureLogs();
    const f = fakes("staging", () => "ok", 0, flipped);
    const r = await runNightly(f.env, NOW, { concurrency: 1 });
    expect(r.ok).toEqual([idOf(0), idOf(4)]);
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual([idOf(1), idOf(2), idOf(3)]);
    expect(f.calls.map((c) => c.script)).toEqual(
      [0, 4].map((n) => `oa-s-${idOf(n)}`),
    );
    expect(lines).toEqual(
      [1, 2, 3].map((n) => `nightly skipped state ${idOf(n)}`),
    );
  });

  it("an expired lease doesn't block the call", async () => {
    await seed([{ id: idOf(0), state: "active", leaseUntil: Date.now() - 1 }]);
    const f = fakes();
    expect((await runNightly(f.env, NOW)).ok).toEqual([idOf(0)]);
  });

  it("an install already leased at read time is skipped", async () => {
    await seed([
      { id: idOf(0), state: "active", leaseUntil: Date.now() + 60_000 },
      { id: idOf(1), state: "active" },
    ]);
    const f = fakes();
    const r = await runNightly(f.env, NOW);
    expect(r).toEqual({
      ok: [idOf(1)],
      failed: [],
      skipped: [idOf(0)],
      ...NONE,
    });
  });

  it("stops dispatching at deadlineMs; the rest is skipped and never called", async () => {
    await seed(ids(10));
    const f = fakes("staging", () => "ok", 40);
    const r = await runNightly(f.env, NOW, {
      concurrency: 1,
      deadlineMs: 100,
    });
    expect(r.failed).toEqual([]);
    expect(r.ok.length).toBeGreaterThanOrEqual(1);
    expect(r.skipped.length).toBeGreaterThanOrEqual(5);
    expect([...r.ok, ...r.skipped]).toEqual(ids(10).map((x) => x.id));
    expect(f.calls).toHaveLength(r.ok.length);
  });

  it("logs each skipped id with its reason", async () => {
    await seed(ids(6));
    const lines = captureLogs();
    const f = fakes("staging", () => "ok", 40);
    const r = await runNightly(f.env, 0, { concurrency: 1, deadlineMs: 60 });
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith("nightly skipped"))).toEqual(
      r.skipped.map((id) => `nightly skipped deadline ${id}`),
    );
  });

  it("six hanging installs at the head no longer starve the rest: a stuck call frees its lane after leakMs and counts as leaked", async () => {
    await seed(ids(26));
    const lines = captureLogs();
    // Day 0: the rotation starts at the head, where the six hang.
    const f = fakes("staging", (s) => (n36(s) < 6 ? "hang" : "ok"));
    const r = await runNightly(f.env, 0, {
      timeoutMs: 20,
      leakMs: 30,
      deadlineMs: 5_000,
    });
    const head = [0, 1, 2, 3, 4, 5].map(idOf);
    expect(r.ok).toHaveLength(20);
    expect(r.skipped).toEqual([]);
    expect(r.failed).toEqual(head.map((id) => ({ id, reason: "timeout" })));
    expect(r.leaked).toEqual(head);
    for (const id of head) expect(lines).toContain(`nightly leaked ${id}`);
  });

  it("within leakMs a stuck call still holds its lane (the cap holds)", async () => {
    await seed(ids(8));
    const f = fakes("staging", (s) => (n36(s) < 2 ? "hang" : "ok"), 5);
    const r = await runNightly(f.env, 0, {
      concurrency: 2,
      timeoutMs: 20,
      leakMs: 200,
    });
    expect(r.ok).toHaveLength(6);
    // Nothing else started until the two stuck calls were given up as leaked.
    const firstOk = f.calls.findIndex((c) => n36(c.script) >= 2);
    expect(firstOk).toBe(2);
    expect(r.leaked).toEqual([idOf(0), idOf(1)]);
  });

  it("rotates the start by UTC day, over the stable id order", async () => {
    await seed(ids(5));
    const order = async (day: number) => {
      const f = fakes();
      await runNightly(f.env, day * DAY + 3_600_000, { concurrency: 1 });
      return f.calls.map((c) => n36(c.script));
    };
    expect(await order(0)).toEqual([0, 1, 2, 3, 4]);
    expect(await order(1)).toEqual([1, 2, 3, 4, 0]);
    expect(await order(7)).toEqual([2, 3, 4, 0, 1]);
  });

  it("a different day gives a starved tail its turn", async () => {
    await seed(ids(12));
    const ran = new Set<string>();
    for (const day of [0, 1, 2, 3, 4, 5]) {
      const f = fakes("staging", () => "ok", 30);
      const r = await runNightly(f.env, day * DAY, {
        concurrency: 1,
        deadlineMs: 70,
      });
      for (const id of r.ok) ran.add(id);
    }
    expect(ran.size).toBeGreaterThan(6);
  });

  it("a stalled re-check is skipped after recheckMs, not an unbounded wait", async () => {
    await seed(ids(3));
    const lines = captureLogs();
    const f = fakes();
    const env = {
      ...f.env,
      PLATFORM_DB: recheckDb((id) => (id === idOf(1) ? "stall" : "ok")),
    } as Env;
    const r = await runNightly(env, 0, { recheckMs: 30 });
    expect([...r.ok].sort()).toEqual([idOf(0), idOf(2)]);
    expect(r.skipped).toEqual([idOf(1)]);
    expect(r.failed).toEqual([]);
    expect(lines).toEqual([`nightly skipped recheck ${idOf(1)}`]);
  });

  it("a stalled re-check is bounded by the deadline too", async () => {
    await seed(ids(1));
    const f = fakes();
    const env = {
      ...f.env,
      PLATFORM_DB: recheckDb(() => "stall"),
    } as Env;
    const t0 = Date.now();
    const r = await runNightly(env, 0, { deadlineMs: 40, recheckMs: 5_000 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.skipped).toEqual([idOf(0)]);
    expect(f.calls).toEqual([]);
  });

  it("a D1 error on the re-check is db_error, never blamed on the install", async () => {
    await seed(ids(3));
    const lines = captureLogs();
    const f = fakes();
    const env = {
      ...f.env,
      PLATFORM_DB: recheckDb((id) => (id === idOf(1) ? "throw" : "ok")),
    } as Env;
    const r = await runNightly(env, 0, { concurrency: 1 });
    expect(r.ok).toEqual([idOf(0), idOf(2)]);
    expect(r.failed).toEqual([]);
    expect(r.dbErrors).toEqual([idOf(1)]);
    expect(lines).toEqual([`nightly db_error ${idOf(1)}`]);
    expect(lines.join("\n")).not.toMatch(/D1_ERROR/);
  });

  it("three consecutive db_errors stop dispatching; the rest is skipped and the summary still lands", async () => {
    await seed(ids(10));
    const lines = captureLogs();
    const f = fakes();
    const env = { ...f.env, PLATFORM_DB: recheckDb(() => "throw") } as Env;
    const r = await nightly(env, 0, { concurrency: 1 });
    expect(r.dbErrors).toEqual([0, 1, 2].map(idOf));
    expect(r.skipped).toEqual([3, 4, 5, 6, 7, 8, 9].map(idOf));
    expect(f.calls).toEqual([]);
    expect(lines.at(-1)).toBe(
      "nightly summary active=10 ok=0 failed=0 skipped=7 db_errors=3 leaked=0",
    );
    for (const l of lines) expect(l).toMatch(LOG_LINE);
  });

  it("a successful re-check resets the db_error streak", async () => {
    await seed(ids(7));
    const f = fakes();
    const bad = new Set([0, 1, 3, 4, 6].map(idOf));
    const env = {
      ...f.env,
      PLATFORM_DB: recheckDb((id) => (bad.has(id) ? "throw" : "ok")),
    } as Env;
    const r = await runNightly(env, 0, { concurrency: 1 });
    expect(r.dbErrors).toEqual([...bad]);
    expect(r.ok).toEqual([idOf(2), idOf(5)]);
    expect(r.skipped).toEqual([]);
  });

  it("logs each failure when it happens, not at the end", async () => {
    await seed(ids(2));
    const lines = captureLogs();
    const f = fakes("staging", (s) => (n36(s) === 0 ? "throw" : "hang"));
    let done = false;
    const p = runNightly(f.env, NOW, { timeoutMs: 400 }).then((r) => {
      done = true;
      return r;
    });
    for (let k = 0; k < 50 && lines.length === 0; k++) await realSleep(5);
    expect(lines).toEqual([`nightly failed exception ${idOf(0)}`]);
    expect(done).toBe(false);
    await p;
    expect(lines).toEqual([
      `nightly failed exception ${idOf(0)}`,
      `nightly failed timeout ${idOf(1)}`,
    ]);
  });

  it("refuses bad options before reading or calling anything", async () => {
    await seed(ids(1));
    const f = fakes();
    for (const o of [
      { concurrency: 0 },
      { concurrency: -1 },
      { concurrency: 1.5 },
      { concurrency: Number.NaN },
      { concurrency: Number.POSITIVE_INFINITY },
      { timeoutMs: 0 },
      { timeoutMs: Number.NaN },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { deadlineMs: 0 },
      { deadlineMs: Number.NaN },
      { pageSize: 0 },
      { pageSize: 2.5 },
      { leakMs: 0 },
      { leakMs: Number.NaN },
      { recheckMs: 0 },
      { recheckMs: Number.POSITIVE_INFINITY },
    ])
      await expect(runNightly(f.env, NOW, o)).rejects.toThrow(RangeError);
    expect(f.scripts).toEqual([]);
  });

  it("a rejection carries the install's own error text: it never reaches logs or results", async () => {
    await seed(ids(3));
    const lines = captureLogs();
    const f = fakes("staging", (s) =>
      n36(s) === 0 ? "throw" : n36(s) === 1 ? "missing" : "ok",
    );
    const r = await nightly(f.env, NOW);
    expect(r.ok).toEqual([idOf(2)]);
    expect(r.failed).toEqual([
      { id: idOf(0), reason: "exception" },
      { id: idOf(1), reason: "not_found" },
    ]);
    const out = `${lines.join("\n")}\n${JSON.stringify(r)}`;
    expect(out).not.toMatch(
      /@|https?:|open-artifacts\.app|\/c\/|SECRET|boom|Worker not found|oa-s-/,
    );
    for (const l of lines) expect(l).toMatch(LOG_LINE);
  });

  it("more than 300 active installs logs the scale warning", async () => {
    await seed(ids(301));
    const lines = captureLogs();
    const f = fakes();
    const r = await runNightly(f.env, NOW, { concurrency: 50 });
    expect(r.ok).toHaveLength(301);
    expect(lines.filter((l) => l.startsWith("nightly scale"))).toEqual([
      "nightly scale active=301 over 300",
    ]);
  });

  it("300 active installs log no scale warning (no 32-invocation cap: measured on staging)", async () => {
    await seed(ids(300));
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
    // The binding is lazy: the missing script fails on its call.
    expect(f.calls.map((c) => c.opts)).toEqual([
      { cron: CRON, scheduledTime: new Date(1234) },
      { cron: CRON, scheduledTime: new Date(1234) },
      { cron: CRON, scheduledTime: new Date(1234) },
    ]);
    expect([...lines].sort()).toEqual(
      [
        `nightly failed exception ${idOf(1)}`,
        `nightly failed not_found ${idOf(2)}`,
        "nightly invalid ids=1",
        "nightly summary active=3 ok=1 failed=2 skipped=0 db_errors=0 leaked=0",
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
      { result: { outcome: "ok", noRetry: false } },
    ];
    await seed([
      ...Array.from({ length: 301 }, (_, n) => ({
        id: idOf(n),
        state: "active" as State,
      })),
      { id: "x@customer.test", state: "active" },
    ]);
    const lines = captureLogs();
    const f = fakes("staging", (s) => kinds[n36(s) % kinds.length] as Behavior);
    // The real handler path (scheduled calls nightly with the defaults).
    const { ok, failed, skipped } = await nightly(f.env, NOW, {
      concurrency: 50,
      timeoutMs: 20,
      deadlineMs: 500,
    });
    expect(ok.length + failed.length + skipped.length).toBe(301);
    for (const r of ["timeout", "exception", "canceled", "not_found"])
      expect(failed.some((x) => x.reason === r)).toBe(true);
    expect(lines.filter((l) => l.startsWith("nightly failed"))).toHaveLength(
      failed.length,
    );
    expect(lines.filter((l) => l.startsWith("nightly summary"))).toEqual([
      `nightly summary active=301 ok=${ok.length} failed=${failed.length} skipped=${skipped.length} db_errors=0 leaked=0`,
    ]);
    for (const l of lines) expect(l).toMatch(LOG_LINE);
  });

  it("zero installs logs only the summary", async () => {
    const lines = captureLogs();
    const f = fakes();
    await scheduler.scheduled(controller(NOW), f.env, createExecutionContext());
    expect(lines).toEqual([
      "nightly summary active=0 ok=0 failed=0 skipped=0 db_errors=0 leaked=0",
    ]);
    expect(f.scripts).toEqual([]);
  });

  it("an aborted run logs a fixed line and still fails the invocation", async () => {
    await seed(ids(1));
    const lines = captureLogs();
    const bad = fakes("dev" as "prod");
    await expect(
      scheduler.scheduled(controller(NOW), bad.env, createExecutionContext()),
    ).rejects.toThrow();
    expect(lines).toEqual(["nightly aborted env"]);
    expect(bad.scripts).toEqual([]);
  });
});
