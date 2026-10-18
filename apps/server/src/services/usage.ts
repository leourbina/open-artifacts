import { type Usage, UsageSchema } from "@oa/shared";
import type { Env } from "../env.js";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const TTL_SECONDS = 300;

const QUERY = `query($a: String!, $day: Date!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $a }) {
    workers: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $from, datetime_leq: $to }) { sum { requests } }
    d1: d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date: $day }) { sum { rowsRead rowsWritten } }
    dos: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date: $day }) { sum { requests } }
  } }
}`;

type Rows = Record<string, number>[];
type Acct = { workers: Rows; d1: Rows; dos: Rows };

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** Strict: every row is `{sum: {<field>: finite number >= 0}}`; else null. */
function rows(x: unknown, fields: string[]): Rows | null {
  if (!Array.isArray(x)) return null;
  const out: Rows = [];
  for (const r of x) {
    if (!isObj(r) || !isObj(r.sum)) return null;
    const row: Record<string, number> = {};
    for (const f of fields) {
      const v = r.sum[f];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
      row[f] = v;
    }
    out.push(row);
  }
  return out;
}

function parseResponse(j: unknown): Acct | null {
  if (!isObj(j) || (j.errors != null && j.errors !== undefined)) return null;
  const data = j.data;
  if (!isObj(data) || !isObj(data.viewer)) return null;
  const accts = data.viewer.accounts;
  if (!Array.isArray(accts) || !isObj(accts[0])) return null;
  const a = accts[0];
  const workers = rows(a.workers, ["requests"]);
  const d1 = rows(a.d1, ["rowsRead", "rowsWritten"]);
  const dos = rows(a.dos, ["requests"]);
  return workers && d1 && dos ? { workers, d1, dos } : null;
}

const total = (xs: Rows, k: string) => xs.reduce((n, x) => n + (x[k] ?? 0), 0);

async function query(env: Env, now: Date, date: string): Promise<Usage> {
  const none: Usage = { available: false, date, metrics: [] };
  try {
    const res = await fetch(GRAPHQL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ANALYTICS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          a: env.CF_ACCOUNT_ID,
          day: date,
          from: `${date}T00:00:00Z`,
          to: now.toISOString(),
        },
      }),
    });
    if (!res.ok) return none;
    const acct = parseResponse(await res.json());
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
      ],
    };
  } catch {
    return none;
  }
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
    if (p.success) return p.data;
  }
  const usage = await query(env, now, date);
  if (usage.available)
    await cache.put(
      key,
      new Response(JSON.stringify(usage), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${TTL_SECONDS}`,
        },
      }),
    );
  return usage;
}
