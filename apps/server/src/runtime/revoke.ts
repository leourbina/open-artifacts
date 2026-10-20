import type { Env } from "../env.js";
import { logError } from "../log.js";
import { type GoneReason, runtimeStub } from "./do.js";

type Ctx = Pick<ExecutionContext, "waitUntil">;

/** At most this many artifact DOs are signalled per call (best effort). */
export const MAX_CLOSE = 50;

/**
 * Closes the live-data sockets (4403) of each artifact's runtime DO after an
 * access change (share revoked, visibility changed, deleted, member removed).
 * Subscribers reconnect through the shell, which re-checks access. Runs in
 * waitUntil when a context is given; never throws. `gone` is the R.events
 * frame's reason: "deleted" for a soft delete, "changed" otherwise.
 */
export async function closeRuntimeSockets(
  env: Pick<Env, "ARTIFACT_RUNTIME">,
  ids: readonly string[],
  reason: string,
  ctx?: Ctx,
  gone: GoneReason = "changed",
): Promise<void> {
  const all = Promise.allSettled(
    [...new Set(ids)]
      .slice(0, MAX_CLOSE)
      .map((id) => runtimeStub(env, id).closeSockets(reason, gone)),
  ).then((rs) => {
    for (const r of rs)
      if (r.status === "rejected") logError("close_sockets_failed", r.reason);
  });
  if (ctx) ctx.waitUntil(all);
  else await all;
}
