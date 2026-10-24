import {
  ForeignResource,
  isInstallId,
  names,
  type Env as OaEnv,
} from "@oa/provision/names";

export interface Env {
  DISPATCHER: DispatchNamespace;
  /** Platform D1 (installs metadata only; no customer data). */
  PLATFORM_DB: D1Database;
  OA_ENV: OaEnv;
}

/** The cron of this Worker and of a self-hosted install (wrangler.template.jsonc). */
export const CRON = "17 3 * * *";

/**
 * 6 at a time × 25 s each fits about 190 slow installs in the 13-minute
 * deadline. Dispatch calls hit no 32-invocation cap (measured on staging,
 * 2026-10-24: 100 sequential calls from one request; docs/ops/hosted.md).
 * M2 replaces the loop with a Queue fan-out (one message per install); until
 * then, warn above this many.
 */
const SCALE_WARN = 300;

export type Reason = "timeout" | "not_found" | "canceled" | "exception";

export interface NightlyResult {
  ok: string[];
  failed: { id: string; reason: Reason }[];
  /** Not called: left active or took a lease before its turn, or past the deadline. */
  skipped: string[];
}

export interface NightlyOptions {
  /**
   * Calls in flight, counting timed-out calls until they settle. Calling a
   * service binding doesn't count toward the 6 simultaneous open connections,
   * but the callee's own fetch, KV, R2, Cache and Queues calls share the
   * top-level request's limit while they wait for headers
   * (https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections,
   * https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits).
   */
  concurrency?: number;
  timeoutMs?: number;
  /** No new call starts after this; under the 15-minute cron wall time. */
  deadlineMs?: number;
  pageSize?: number;
}

// Keyset pages, so a large table is never one result set.
const PAGE_SQL =
  "SELECT id FROM installs WHERE state = 'active' AND id > ?1 ORDER BY id LIMIT ?2";

// Right before each call: still active, and no live lifecycle lease
// (provision holds one through upgrade, rollback and delete).
const RECHECK_SQL =
  "SELECT 1 AS ok FROM installs WHERE id = ?1 AND state = 'active' AND (lease_until IS NULL OR lease_until <= ?2)";

/**
 * Measured on staging through a dispatch namespace (2026-10-24): scheduled()
 * resolves to undefined when the install's handler succeeds and rejects with
 * the handler's own error when it throws. The { outcome, noRetry } result of
 * the experimental workers-types is handled defensively. scheduledTime is a
 * Date, as in the Workers docs for service bindings
 * (https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
 */
interface ScheduledFetcher {
  scheduled(o: { cron?: string; scheduledTime?: Date }): Promise<unknown>;
}

class Canceled extends Error {}
class NotFound extends Error {}

/**
 * A fixed category; never the error text: a rejection carries the install's
 * own error message (emails, URLs), so it is neither logged nor returned.
 */
const category = (e: unknown): Exclude<Reason, "timeout"> =>
  e instanceof Canceled
    ? "canceled"
    : e instanceof NotFound ||
        (e instanceof Error && e.message.startsWith("Worker not found"))
      ? "not_found"
      : "exception";

/** Resolving to undefined is ok; any other result but outcome "ok" fails closed. */
function checkOutcome(r: unknown): void {
  if (r === undefined) return;
  const outcome =
    typeof r === "object" && r !== null
      ? (r as { outcome?: unknown }).outcome
      : undefined;
  if (outcome === "ok") return;
  if (outcome === "canceled") throw new Canceled();
  if (outcome === "scriptNotFound") throw new NotFound();
  throw new Error("outcome");
}

async function activeIds(
  db: D1Database,
  pageSize: number,
): Promise<{ ids: string[]; invalid: number }> {
  const ids: string[] = [];
  let invalid = 0;
  let after = "";
  for (;;) {
    const { results } = await db
      .prepare(PAGE_SQL)
      .bind(after, pageSize)
      .all<{ id: unknown }>();
    for (const r of results)
      if (typeof r.id === "string") ids.push(r.id);
      else invalid++;
    if (results.length < pageSize) return { ids, invalid };
    const last = results.at(-1)?.id;
    // TEXT affinity makes this near-impossible; never drop the later pages.
    if (typeof last !== "string")
      throw new Error("installs page ends on a non-text id");
    after = last;
  }
}

function positive(name: string, v: number, integer: boolean): number {
  if (!Number.isFinite(v) || v < 1 || (integer && !Number.isInteger(v)))
    throw new RangeError(
      `${name} must be a finite ${integer ? "integer " : ""}>= 1`,
    );
  return v;
}

const logFailed = (reason: Reason, id: string) =>
  console.error("nightly failed", reason, id);

/**
 * Calls scheduled() on every `active` install's script, re-checking right
 * before each call that it is still active with no live lease. At most
 * `concurrency` calls are in flight, a timed-out one included until it
 * settles; each call is reported `timeout` after `timeoutMs`. No call starts
 * after `deadlineMs`. One install throwing or timing out never stops the
 * others. Each failure is logged when it happens.
 */
export async function runNightly(
  env: Env,
  now: number,
  {
    concurrency = 6,
    timeoutMs = 25_000,
    deadlineMs = 13 * 60_000,
    pageSize = 500,
  }: NightlyOptions = {},
): Promise<NightlyResult> {
  positive("concurrency", concurrency, true);
  positive("timeoutMs", timeoutMs, false);
  positive("deadlineMs", deadlineMs, false);
  positive("pageSize", pageSize, true);
  const start = Date.now();

  const rows = await activeIds(env.PLATFORM_DB, pageSize);
  const ids = rows.ids.filter((id) => isInstallId(id));
  // Resolve every script name first: an unknown OA_ENV throws before any call.
  const scripts = ids.map((id) => names(id, env.OA_ENV).script);
  const invalid = rows.invalid + rows.ids.length - ids.length;
  if (invalid > 0) console.warn("nightly invalid", `ids=${invalid}`);
  if (ids.length > SCALE_WARN)
    console.warn("nightly scale", `active=${ids.length} over ${SCALE_WARN}`);

  const ok: string[] = [];
  const failed: NightlyResult["failed"] = [];
  const skipped: string[] = [];
  const fail = (id: string, reason: Reason) => {
    failed.push({ id, reason });
    logFailed(reason, id);
  };

  let next = 0;
  let held = 0; // lanes held: from the re-check until the call settles
  let undecided = 0; // started calls with no result yet
  let stopped = false;

  await new Promise<void>((resolve) => {
    let finished = false;
    const deadline = setTimeout(
      () => {
        stopped = true;
        pump();
      },
      Math.max(0, start + deadlineMs - Date.now()),
    );
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      resolve();
    };
    function pump() {
      if (finished) return;
      while (!stopped && held < concurrency && next < ids.length) run(next++);
      // Done once nothing more will start and every started call has a result;
      // timed-out calls may still hold lanes, but they never block the return.
      if ((stopped || next >= ids.length) && undecided === 0) finish();
    }
    async function run(i: number) {
      const id = ids[i] as string;
      held++;
      undecided++;
      let decided = false;
      const decide = (f: () => void) => {
        if (decided) return;
        decided = true;
        undecided--;
        f();
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const still = await env.PLATFORM_DB.prepare(RECHECK_SQL)
          .bind(id, Date.now())
          .first();
        if (!still) {
          decide(() => skipped.push(id));
          return;
        }
        // A timeout is reported now; the lane stays held until the call settles.
        timer = setTimeout(() => {
          decide(() => fail(id, "timeout"));
          pump();
        }, timeoutMs);
        const r = await (
          env.DISPATCHER.get(
            scripts[i] as string,
          ) as unknown as ScheduledFetcher
        ).scheduled({ cron: CRON, scheduledTime: new Date(now) });
        checkOutcome(r);
        decide(() => ok.push(id));
      } catch (e) {
        decide(() => fail(id, category(e)));
      } finally {
        clearTimeout(timer);
        held--;
        pump();
      }
    }
    pump();
  });

  // Past the deadline: everything not started is skipped, in id order.
  for (let i = next; i < ids.length; i++) skipped.push(ids[i] as string);
  return { ok, failed, skipped };
}

/** runNightly plus the summary line; an aborted run logs a fixed line and rethrows. */
export async function nightly(
  env: Env,
  now: number,
  o?: NightlyOptions,
): Promise<NightlyResult> {
  let r: NightlyResult;
  try {
    r = await runNightly(env, now, o);
  } catch (e) {
    console.error(
      "nightly aborted",
      e instanceof ForeignResource ? "env" : "exception",
    );
    throw e;
  }
  const { ok, failed, skipped } = r;
  console.log(
    "nightly summary",
    `active=${ok.length + failed.length + skipped.length} ok=${ok.length} failed=${failed.length} skipped=${skipped.length}`,
  );
  return r;
}

export default {
  async scheduled(event, env, _ctx) {
    await nightly(env, event.scheduledTime);
    // TODO(Backend): the email-quota alert (80% of the account limit) needs
    // each install's send count for the previous day. The counters live in
    // the install's own D1 (`counters`, keys `email:*` and `code:*`), are
    // swept by its own nightly job, and no route exposes them. Backend to
    // define that contract before the scheduler sums them.
  },
} satisfies ExportedHandler<Env>;
