import { type Usage, UsageSchema } from "@oa/shared";
import type { Env } from "../env.js";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const TTL_SECONDS = 300;

/** Free plan: 10 ms CPU per invocation. */
const FREE_CPU_MS = 10;
/** Tool results carry the CPU-limit nudge at this many hits today. */
const NUDGE_HITS = 3;

/** This Worker only: today's CPU-limit outcomes and p99 CPU time (µs). */
const CPU_FIELDS = `
    cpuHits: workersInvocationsAdaptive(limit: 10, filter: { scriptName: $s, datetime_geq: $from, datetime_leq: $to, status_in: ["exceededCpu", "exceededResources"] }) { sum { requests } }
    cpu: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $s, datetime_geq: $from, datetime_leq: $to }) { quantiles { cpuTimeP99 } }`;

/** OAUTH_KV only: today's write operations. */
const KV_FIELDS = `
    kv: kvOperationsAdaptiveGroups(limit: 10, filter: { namespaceId: $kv, date: $day, actionType: "write" }) { sum { requests } }`;

const buildQuery = (cpu: boolean, kv: boolean) =>
  `query($a: String!, $day: Date!, $from: Time!, $to: Time!${cpu ? ", $s: String!" : ""}${kv ? ", $kv: String!" : ""}) {
  viewer { accounts(filter: { accountTag: $a }) {
    workers: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $from, datetime_leq: $to }) { sum { requests } }
    d1: d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date: $day }) { sum { rowsRead rowsWritten } }
    dos: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date: $day }) { sum { requests } }${cpu ? CPU_FIELDS : ""}${kv ? KV_FIELDS : ""}
  } }
}`;

type Rows = Record<string, number>[];
type Acct = {
  workers: Rows;
  d1: Rows;
  dos: Rows;
  /** Null when not queried or malformed: the CPU metrics are omitted. */
  cpu: { hits: number; p99Ms: number } | null;
  /** Null when not queried or malformed: kv_writes is omitted. */
  kv: Rows | null;
};

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** Strict: every row is `{<group>: {<field>: finite number >= 0}}`; else null. */
function rows(x: unknown, fields: string[], group = "sum"): Rows | null {
  if (!Array.isArray(x)) return null;
  const out: Rows = [];
  for (const r of x) {
    if (!isObj(r) || !isObj(r[group])) return null;
    const row: Record<string, number> = {};
    for (const f of fields) {
      const v = (r[group] as Record<string, unknown>)[f];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
      row[f] = v;
    }
    out.push(row);
  }
  return out;
}

function parseResponse(
  j: unknown,
  withCpu: boolean,
  withKv: boolean,
): Acct | null {
  if (!isObj(j) || (j.errors != null && j.errors !== undefined)) return null;
  const data = j.data;
  if (!isObj(data) || !isObj(data.viewer)) return null;
  const accts = data.viewer.accounts;
  if (!Array.isArray(accts) || !isObj(accts[0])) return null;
  const a = accts[0];
  const workers = rows(a.workers, ["requests"]);
  const d1 = rows(a.d1, ["rowsRead", "rowsWritten"]);
  const dos = rows(a.dos, ["requests"]);
  if (!workers || !d1 || !dos) return null;
  const hits = withCpu ? rows(a.cpuHits, ["requests"]) : null;
  const p99 = withCpu ? rows(a.cpu, ["cpuTimeP99"], "quantiles") : null;
  const cpu =
    hits && p99
      ? {
          hits: total(hits, "requests"),
          // cpuTime is in microseconds; no rows (no invocations yet) -> 0.
          p99Ms: Math.round(p99[0]?.cpuTimeP99 ?? 0) / 1000,
        }
      : null;
  const kv = withKv ? rows(a.kv, ["requests"]) : null;
  return { workers, d1, dos, cpu, kv };
}

const total = (xs: Rows, k: string) => xs.reduce((n, x) => n + (x[k] ?? 0), 0);

async function query(env: Env, now: Date, date: string): Promise<Usage> {
  const none: Usage = { available: false, date, metrics: [] };
  const withCpu = !!env.WORKER_NAME;
  const withKv = !!env.OAUTH_KV_ID;
  try {
    const res = await fetch(GRAPHQL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ANALYTICS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: buildQuery(withCpu, withKv),
        variables: {
          a: env.CF_ACCOUNT_ID,
          day: date,
          from: `${date}T00:00:00Z`,
          to: now.toISOString(),
          ...(withCpu ? { s: env.WORKER_NAME } : {}),
          ...(withKv ? { kv: env.OAUTH_KV_ID } : {}),
        },
      }),
    });
    if (!res.ok) return none;
    const acct = parseResponse(await res.json(), withCpu, withKv);
    if (!acct) return none;
    return {
      available: true,
      date,
      metrics: [
        {
          key: "requests",
          used: total(acct.workers, "requests"),
          limit: 100_000,
        },
        {
          key: "d1_reads",
          used: total(acct.d1, "rowsRead"),
          limit: 5_000_000,
        },
        {
          key: "d1_writes",
          used: total(acct.d1, "rowsWritten"),
          limit: 100_000,
        },
        {
          key: "do_requests",
          used: total(acct.dos, "requests"),
          limit: 100_000,
        },
        ...(acct.cpu
          ? [
              { key: "cpu_limit_hits" as const, used: acct.cpu.hits, limit: 0 },
              {
                key: "cpu_p99_ms" as const,
                used: acct.cpu.p99Ms,
                limit: FREE_CPU_MS,
              },
            ]
          : []),
        ...(acct.kv
          ? [
              {
                key: "kv_writes" as const,
                used: total(acct.kv, "requests"),
                limit: 1_000,
              },
            ]
          : []),
      ],
    };
  } catch {
    return none;
  }
}

/** Per-isolate copy of the last usage read: what the MCP nudge reads (no fetch). */
let last: Usage | null = null;
const remember = (u: Usage) => {
  last = u;
  return u;
};

/** The MCP nudge line, from the last cached usage read when it is today's and ≥ 3 hits. */
export function cpuNudge(now = new Date()): string | null {
  if (!last?.available || last.date !== now.toISOString().slice(0, 10))
    return null;
  const n = last.metrics.find((m) => m.key === "cpu_limit_hits")?.used ?? 0;
  return n >= NUDGE_HITS
    ? `Your instance hit Cloudflare's free-plan CPU limit ${n} times today. See Settings → Usage for the fix (Workers Paid).`
    : null;
}

/** Today's (UTC) free-plan usage; cached 5 minutes per account and date. */
export async function getUsage(env: Env): Promise<Usage> {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  if (!env.ANALYTICS_TOKEN) return { available: false, date, metrics: [] };
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`https://usage.invalid/${env.CF_ACCOUNT_ID}/${date}`);
  const hit = await cache.match(key);
  if (hit) {
    const p = UsageSchema.safeParse(await hit.json());
    if (p.success) return remember(p.data);
  }
  const usage = await query(env, now, date);
  if (usage.available) {
    remember(usage);
    await cache.put(
      key,
      new Response(JSON.stringify(usage), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${TTL_SECONDS}`,
        },
      }),
    );
  }
  return usage;
}
