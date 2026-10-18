import type { Env } from "./env.js";
import { purgeDeleted } from "./services/artifacts.js";
import { sweepUploads } from "./services/uploads.js";

/** Daily cron: purge soft-deleted artifacts past 30 days, sweep stale uploads. */
export async function scheduled(
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const now = Date.now();
  ctx.waitUntil(
    Promise.allSettled([purgeDeleted(env, now), sweepUploads(env, now)]).then(
      (rs) => {
        for (const r of rs)
          if (r.status === "rejected") console.error("cron", r.reason);
        return rs;
      },
    ),
  );
}
