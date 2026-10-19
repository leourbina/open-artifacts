import type { Me } from "@oa/shared";
import { useSyncExternalStore } from "react";
import { lastCpuLimitAt, subscribeCpuLimit } from "../api/client";
import { useUsage } from "../api/queries";

export const CPU_DOC =
  "https://open-artifacts.com/docs/self-hosting-costs/#hitting-the-cpu-limit";
export const COSTS_DOC = "https://open-artifacts.com/docs/self-hosting-costs/";
export const PLANS_URL =
  "https://dash.cloudflare.com/?to=/:account/workers/plans";

type Role = Me["user"]["role"];

/** A 1102 this long ago still counts as "just now": analytics lag a few minutes. */
const RECENT_MS = 15 * 60_000;
/** The server caches Cloudflare's numbers for 5 minutes; no point asking sooner. */
const USAGE_STALE_MS = 5 * 60_000;

/** `YYYY-MM-DD` in UTC, the day the free plan's limits reset on. */
export const utcDay = (t = Date.now()) =>
  new Date(t).toISOString().slice(0, 10);

/**
 * What the shell knows about CPU-limit trouble today: `hits` from usage (owners and
 * admins only, null when unknown) and whether this tab just got a 1102.
 */
export function useCpuSignals(role: Role | null | undefined) {
  // `role` comes from the caller: a fresh useMe observer here would refetch an
  // errored /me on mount and flip the caller back to loading.
  const admin = role === "owner" || role === "admin";
  const usage = useUsage({ enabled: admin, staleTime: USAGE_STALE_MS });
  const at = useSyncExternalStore(
    subscribeCpuLimit,
    lastCpuLimitAt,
    lastCpuLimitAt,
  );
  const now = Date.now();
  const today = utcDay(now);
  const data = admin ? usage.data : undefined;
  const hits =
    data?.available && data.date === today
      ? (data.metrics.find((m) => m.key === "cpu_limit_hits")?.used ?? null)
      : null;
  const recent = at !== null && now - at < RECENT_MS && utcDay(at) === today;
  return { admin, hits, recent, today };
}
