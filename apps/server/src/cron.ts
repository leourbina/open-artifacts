import { sweepLoginCodes } from "./auth/codes.js";
import { sweepEmailCounters } from "./email/send.js";
import type { Env } from "./env.js";
import { logError } from "./log.js";
import { sweepUngrantedClients } from "./mcp/registrations.js";
import { purgeDeleted, reindexStale } from "./services/artifacts.js";
import { checkLatestRelease } from "./services/release.js";
import { sweepUploads } from "./services/uploads.js";

const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Drops /__oa/nightly nonces older than 2 days (their ts window is long gone). */
export async function sweepNightlyRuns(env: Env, now: number): Promise<void> {
  await env.DB.prepare("DELETE FROM nightly_runs WHERE day < ?")
    .bind(utcDay(now - 2 * DAY_MS))
    .run();
}

/**
 * The nightly job, from the cron trigger (scheduled) or, on hosted installs,
 * the signed POST /__oa/nightly: purge soft-deleted artifacts past 30 days,
 * sweep stale uploads, delete OAuth clients that never completed a grant,
 * re-enqueue search indexing that never completed (C3), drop past days' email
 * counters and expired sign-in codes, check the latest release (B3), drop old
 * nightly nonces.
 */
export async function runNightly(
  env: Env,
  _ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<PromiseSettledResult<unknown>[]> {
  const now = Date.now();
  const rs = await Promise.allSettled([
    purgeDeleted(env, now),
    sweepUploads(env, now),
    sweepUngrantedClients(env, now),
    reindexStale(env, now),
    sweepEmailCounters(env, now),
    sweepLoginCodes(env, now),
    checkLatestRelease(env, now),
    sweepNightlyRuns(env, now),
  ]);
  for (const r of rs)
    if (r.status === "rejected") logError("cron_task_failed", r.reason);
  return rs;
}

/** Daily cron trigger: runNightly under ctx.waitUntil. */
export async function scheduled(
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(runNightly(env, ctx));
}
