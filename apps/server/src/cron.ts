import { sweepEmailCounters } from "./email/send.js";
import type { Env } from "./env.js";
import { sweepUngrantedClients } from "./mcp/registrations.js";
import { purgeDeleted, reindexStale } from "./services/artifacts.js";
import { sweepUploads } from "./services/uploads.js";

/** Daily cron: purge soft-deleted artifacts past 30 days, sweep stale uploads,
 * delete OAuth clients that never completed a grant, re-enqueue search
 * indexing that never completed (C3), drop past days' email counters. */
export async function scheduled(
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const now = Date.now();
  ctx.waitUntil(
    Promise.allSettled([
      purgeDeleted(env, now),
      sweepUploads(env, now),
      sweepUngrantedClients(env, now),
      reindexStale(env, now),
      sweepEmailCounters(env, now),
    ]).then((rs) => {
      for (const r of rs)
        if (r.status === "rejected") console.error("cron", r.reason);
      return rs;
    }),
  );
}
