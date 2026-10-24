import { isInstallId, names, type Env as OaEnv } from "@oa/provision/names";

export interface Env {
  DISPATCHER: DispatchNamespace;
  /** Platform D1 (installs metadata only; no customer data). */
  PLATFORM_DB: D1Database;
  OA_ENV: OaEnv;
}

/** The cron of this Worker and of a self-hosted install (wrangler.template.jsonc). */
export const CRON = "17 3 * * *";

/**
 * 10 at a time × 25 s each fits about 360 installs in one cron invocation's
 * wall time. M2 replaces the loop with a Queue fan-out (one message per
 * install); until then, warn above this many.
 */
const SCALE_WARN = 300;

export type Reason = "timeout" | "not_found" | "canceled" | "exception";

export interface NightlyResult {
  ok: string[];
  failed: { id: string; reason: Reason }[];
}

// Keyset pages, so a large table is never one result set.
const PAGE_SQL =
  "SELECT id FROM installs WHERE state = 'active' AND id > ?1 ORDER BY id LIMIT ?2";

/**
 * Fetcher.scheduled(options) resolves with { outcome, noRetry }; it does not
 * reject when the install's handler throws (outcome "exception"). Its
 * scheduledTime is a Date, as in the Workers docs for service bindings
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
 * Only the experimental workers-types declare it; the Task 1 spike ran it
 * through a namespace binding (docs/ops/hosted.md).
 */
interface ScheduledFetcher {
  scheduled(o: {
    cron?: string;
    scheduledTime?: Date;
  }): Promise<{ outcome: string; noRetry: boolean }>;
}

class Timeout extends Error {}
class Canceled extends Error {}

/** A fixed category; never the error text (it can carry names or URLs). */
const category = (e: unknown): Reason =>
  e instanceof Timeout
    ? "timeout"
    : e instanceof Canceled
      ? "canceled"
      : e instanceof Error && e.message.startsWith("Worker not found")
        ? "not_found"
        : "exception";

async function activeIds(db: D1Database, pageSize: number): Promise<string[]> {
  const ids: string[] = [];
  let after = "";
  for (;;) {
    const { results } = await db
      .prepare(PAGE_SQL)
      .bind(after, pageSize)
      .all<{ id: unknown }>();
    for (const r of results) if (typeof r.id === "string") ids.push(r.id);
    const last = results.at(-1)?.id;
    if (results.length < pageSize || typeof last !== "string") return ids;
    after = last;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Calls scheduled() on every `active` install's script, at most `concurrency`
 * in flight, each raced against `timeoutMs`. Installs in any other state are
 * never called, nor is an id that isn't an install id. One install throwing
 * or timing out never stops the others.
 */
export async function runNightly(
  env: Env,
  now: number,
  {
    concurrency = 10,
    timeoutMs = 25_000,
    pageSize = 500,
  }: { concurrency?: number; timeoutMs?: number; pageSize?: number } = {},
): Promise<NightlyResult> {
  const rows = await activeIds(env.PLATFORM_DB, pageSize);
  const ids = rows.filter((id) => isInstallId(id));
  // Resolve every script name first: an unknown OA_ENV throws before any call.
  const scripts = ids.map((id) => names(id, env.OA_ENV).script);
  if (rows.length > ids.length)
    console.warn("nightly invalid", `ids=${rows.length - ids.length}`);
  if (ids.length > SCALE_WARN)
    console.warn("nightly scale", `active=${ids.length} over ${SCALE_WARN}`);

  const ok: string[] = [];
  const failed: NightlyResult["failed"] = [];
  let next = 0;
  const lane = async () => {
    while (next < ids.length) {
      const i = next++;
      const id = ids[i] as string;
      try {
        const r = await withTimeout(
          // async, so a get() that throws (no such script) rejects here.
          (async () =>
            (
              env.DISPATCHER.get(
                scripts[i] as string,
              ) as unknown as ScheduledFetcher
            ).scheduled({ cron: CRON, scheduledTime: new Date(now) }))(),
          timeoutMs,
        );
        // Fail closed: anything but outcome "ok" (a missing or odd result
        // too) is a failure.
        const outcome = (r as { outcome?: unknown } | null | undefined)
          ?.outcome;
        if (outcome === "canceled") throw new Canceled();
        if (outcome !== "ok") throw new Error("outcome");
        ok.push(id);
      } catch (e) {
        failed.push({ id, reason: category(e) });
      }
    }
  };
  const cap = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const lanes = Math.max(1, Math.min(cap, ids.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  return { ok, failed };
}

export default {
  async scheduled(event, env, _ctx) {
    const { ok, failed } = await runNightly(env, event.scheduledTime);
    for (const f of failed) console.error("nightly failed", f.reason, f.id);
    console.log(
      "nightly summary",
      `active=${ok.length + failed.length} ok=${ok.length} failed=${failed.length}`,
    );
    // TODO(Backend): the email-quota alert (80% of the account limit) needs
    // each install's send count for the previous day. The counters live in
    // the install's own D1 (`counters`, keys `email:*` and `code:*`), are
    // swept by its own nightly job, and no route exposes them. Backend to
    // define that contract before the scheduler sums them.
  },
} satisfies ExportedHandler<Env>;
