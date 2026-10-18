// B17 (ledger): a permanently failing purge must not starve the 50-slot window.
import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { purgeBackoff, purgeDeleted } from "../src/services/artifacts.js";
import { login } from "./helpers.js";

const DAY = 86400_000;
let owner = "";
beforeAll(async () => {
  owner = (await login(`backoff-${newId().slice(0, 6)}@x.com`)).userId;
});

async function deleted(daysAgo: number): Promise<string> {
  const id = newId();
  const t = Date.now() - daysAgo * DAY;
  await env.DB.prepare(
    `insert into artifacts (id, owner_id, title, format, visibility, current_version,
       capabilities, allow_anonymous_writes, created_at, updated_at, deleted_at)
     values (?, ?, 't', 'markdown', 'private', 0, '{}', 0, ?, ?, ?)`,
  )
    .bind(id, owner, t, t, t)
    .run();
  return id;
}
const exists = async (id: string) =>
  (await env.DB.prepare("select 1 from artifacts where id = ?")
    .bind(id)
    .first()) !== null;

/** env whose DO destroy() throws for `failing` ids. */
function failingEnv(failing: Set<string>): Env {
  const ns = env.ARTIFACT_RUNTIME;
  return {
    ...(env as Env),
    ARTIFACT_RUNTIME: {
      idFromName: (n: string) => ({ n }),
      get: (id: { n: string }) =>
        failing.has(id.n)
          ? { destroy: () => Promise.reject(new Error("boom")) }
          : ns.get(ns.idFromName(id.n)),
    } as never,
  };
}

describe("purge backoff", () => {
  it("defers failing artifacts so the next run reaches the rest", async () => {
    const failing = new Set<string>();
    for (let i = 0; i < 50; i++) failing.add(await deleted(60 + i / 100));
    const good = await deleted(40);
    const oldest = [...failing].at(-1);
    const e = failingEnv(failing);
    const now = Date.now();

    expect(await purgeDeleted(e, now)).toBe(0); // window full of failures
    expect(await exists(good)).toBe(true);
    const row = await env.DB.prepare(
      "select purge_attempts a, purge_after t from artifacts where id = ?",
    )
      .bind(oldest)
      .first<{ a: number; t: number }>();
    expect(row?.a).toBe(1);
    expect(row?.t).toBe(now + purgeBackoff(1));

    // Next daily run: the failures queue behind never-failed artifacts.
    expect(await purgeDeleted(e, now + DAY)).toBe(1);
    expect(await exists(good)).toBe(false);

    // A failing one is not retried before its backoff passes.
    const second = await env.DB.prepare(
      "select purge_attempts a, purge_after t from artifacts where id = ?",
    )
      .bind(oldest)
      .first<{ a: number; t: number }>();
    expect(second?.a).toBe(2);
    expect(await purgeDeleted(e, (second?.t ?? 0) - 1)).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "select purge_attempts a from artifacts where id = ?",
        )
          .bind(oldest)
          .first<{ a: number }>()
      )?.a,
    ).toBe(2);
  });

  it("warns purge_failing (structured) from the third failed attempt", async () => {
    const id = await deleted(45);
    const e = failingEnv(new Set([id]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let t = Date.now();
      for (let i = 1; i <= 3; i++) {
        await purgeDeleted(e, t);
        t += purgeBackoff(i) + 60_000;
      }
      const calls = warn.mock.calls.filter(
        (c) => (c[0] as { evt?: string })?.evt === "purge_failing",
      );
      expect(calls).toEqual([[{ evt: "purge_failing", id, attempts: 3 }]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("backoff doubles from one day, capped at 32", () => {
    expect(
      [1, 2, 3, 6, 9].map((n) => Math.round(purgeBackoff(n) / DAY)),
    ).toEqual([1, 2, 4, 32, 32]);
  });
});
