import type { Usage as UsageData } from "@oa/shared";
import { Badge, Banner, Button, toast } from "@oa/ui";
import { useUsage } from "../api/queries";
import { useDocumentTitle } from "../layout/useDocumentTitle";

type Tone = "normal" | "warning" | "danger";
type Metric = UsageData["metrics"][number];

const LABELS: Record<Metric["key"], { name: string; what: string }> = {
  requests: { name: "Worker requests", what: "Views, uploads, agent calls" },
  d1_reads: { name: "D1 rows read", what: "Library, search, listings" },
  d1_writes: { name: "D1 rows written", what: "Publishes, shares, settings" },
  do_requests: {
    name: "Durable Object requests",
    what: "Live-page data and sync",
  },
  cpu_limit_hits: {
    name: "CPU limit hits",
    what: "Requests stopped by the CPU limit",
  },
  cpu_p99_ms: { name: "CPU time p99 (ms)", what: "Slowest 1% of requests" },
  kv_writes: { name: "KV writes", what: "Agent sign-ins and token refreshes" },
};
const BADGE = {
  normal: "neutral",
  warning: "warning",
  danger: "danger",
} as const;

/**
 * Raw percent of the limit. Negative use counts as 0; a limit of 0 (or less) with any
 * use is over the limit (Infinity), with none it is 0. Never NaN.
 */
export const percent = (used: number, limit: number) => {
  if (!(used > 0)) return 0;
  return limit > 0 ? (used / limit) * 100 : Number.POSITIVE_INFINITY;
};
export const toneOf = (pct: number): Tone =>
  pct >= 95 ? "danger" : pct >= 80 ? "warning" : "normal";
const fmt = (n: number) => n.toLocaleString("en-US");

function Meter({ metric }: { metric: Metric }) {
  const { name, what } = LABELS[metric.key];
  const used = Math.max(metric.used, 0);
  const pct = percent(used, metric.limit);
  const tone = toneOf(pct);
  const reached = pct >= 100;
  const shown = pct > 100 ? "100%+" : `${Math.floor(pct)}%`;
  const left = Math.max(metric.limit - used, 0);
  const state = reached
    ? "limit reached"
    : tone === "danger"
      ? "near limit"
      : tone === "warning"
        ? "high"
        : "";
  const badge = reached
    ? "Limit reached"
    : state
      ? `${shown} · ${state}`
      : shown;
  return (
    <section className="oa-card oa-meter" data-tone={tone} aria-label={name}>
      <div className="oa-meter-head">
        <h2>{name}</h2>
        <Badge tone={BADGE[tone]}>{badge}</Badge>
      </div>
      <div className="oa-meter-value">
        <b>{fmt(used)}</b>
        <span>/ {fmt(metric.limit)} today</span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled per tone cross-browser */}
      <div
        className="oa-track"
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={Math.max(metric.limit, 0)}
        aria-valuenow={Math.min(used, Math.max(metric.limit, 0))}
        aria-valuetext={`${fmt(used)} of ${fmt(metric.limit)}${state ? `, ${state}` : ""}`}
        data-tone={tone}
      >
        <i style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <div className="oa-meter-foot">
        <span>{what}</span>
        <span className="oa-left">{fmt(left)} left</span>
      </div>
    </section>
  );
}

const copy = (text: string) => {
  const failed = () =>
    toast({
      title: "Couldn't copy",
      description: "Copy it by hand.",
      tone: "danger",
    });
  if (!navigator.clipboard) return failed();
  navigator.clipboard
    .writeText(text)
    .then(() => toast({ title: "Copied", tone: "success" }), failed);
};

function Cmd({ code, label }: { code: string; label: string }) {
  return (
    <div className="oa-code oa-code-flush">
      <pre>
        <code>{code}</code>
      </pre>
      <Button variant="ghost" aria-label={label} onClick={() => copy(code)}>
        Copy
      </Button>
    </div>
  );
}

function Setup() {
  return (
    <section className="oa-card oa-setup" aria-labelledby="oa-setup-h">
      <h2 id="oa-setup-h">Connect Cloudflare analytics to see usage</h2>
      <p>
        Open Artifacts reads today's numbers from Cloudflare's GraphQL Analytics
        API. It needs a read-only token with the Account Analytics permission,
        stored as the <code>ANALYTICS_TOKEN</code> Worker secret. Everything
        else works without it.
      </p>
      <p>
        Run setup and paste the token when prompted (it asks for{" "}
        <code>ANALYTICS_TOKEN</code>):
      </p>
      <Cmd code="pnpm oa:setup" label="Copy setup command" />
      <p>Or store it directly:</p>
      <Cmd
        code="wrangler secret put ANALYTICS_TOKEN"
        label="Copy wrangler command"
      />
      <p>Then reload this page. The token is never shown in the dashboard.</p>
    </section>
  );
}

/** D4 banners: one per metric at or past the danger threshold, or the empty state. */
function alerts(metrics: Metric[]) {
  if (metrics.every((m) => !(m.used > 0)))
    return (
      <Banner tone="info" title="No usage recorded yet today.">
        Cloudflare's analytics can lag a few minutes behind real traffic.
      </Banner>
    );
  return metrics
    .filter((m) => toneOf(percent(m.used, m.limit)) === "danger")
    .map((m) => {
      const pct = percent(m.used, m.limit);
      const name = LABELS[m.key].name;
      return (
        <Banner
          key={m.key}
          tone="danger"
          title={
            pct >= 100
              ? `${name} have reached today's limit.`
              : `${name} are at ${Math.floor(pct)}% of today's limit.`
          }
        >
          Past the limit, writes fail until 00:00 UTC.
        </Banner>
      );
    });
}

function Guide() {
  return (
    <section className="oa-card oa-guide" aria-labelledby="oa-guide-h">
      <h2 id="oa-guide-h">When to upgrade</h2>
      <p>
        The free plan's limits reset every day at 00:00 UTC. A meter turns amber
        at 80% and red at 95%. Once a limit is reached, writes fail until the
        reset.
      </p>
      <p>
        If one turns red most days, move the account to Workers Paid in the
        Cloudflare dashboard. Nothing in Open Artifacts changes, and no redeploy
        is needed.
      </p>
      <ul>
        <li>
          <b>Worker requests</b> grow with views, uploads, and agent calls.
        </li>
        <li>
          <b>D1</b> grows with library browsing, search, and publishing.
        </li>
        <li>
          <b>Durable Objects</b> grow with live pages: polls, checklists, shared
          data.
        </li>
      </ul>
    </section>
  );
}

export function Usage() {
  useDocumentTitle("Usage");
  const q = useUsage();
  return (
    <div className="oa-settings oa-usage">
      <div className="oa-usage-head">
        <h1>Usage</h1>
        <Button
          variant="ghost"
          disabled={q.isFetching}
          onClick={() => void q.refetch()}
        >
          Refresh
        </Button>
      </div>
      {q.isError ? (
        <Banner
          tone="danger"
          title="Couldn't load usage."
          action={
            <Button variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        >
          This doesn't affect your artifacts.
        </Banner>
      ) : !q.data ? (
        <p aria-busy="true">Loading…</p>
      ) : !q.data.available ? (
        <Setup />
      ) : (
        <>
          {alerts(q.data.metrics)}
          <p className="oa-seen">
            Today, {q.data.date}. Resets at 00:00 UTC. Cloudflare's numbers are
            cached for 5 minutes.
          </p>
          <div className="oa-meters">
            {q.data.metrics.map((m) => (
              <Meter key={m.key} metric={m} />
            ))}
          </div>
          <Guide />
        </>
      )}
    </div>
  );
}
