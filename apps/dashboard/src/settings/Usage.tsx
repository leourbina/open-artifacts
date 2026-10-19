import type { Usage as UsageData } from "@oa/shared";
import { Badge, Banner, Button, toast } from "@oa/ui";
import { useUsage } from "../api/queries";
import { useMe } from "../auth/useMe";
import { ExtIcon } from "../layout/CpuBanner";
import { COSTS_DOC } from "../layout/cpu";
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

/** Per-request CPU numbers: shown in their own card, never as daily meters. */
const CPU_KEYS: ReadonlySet<Metric["key"]> = new Set([
  "cpu_limit_hits",
  "cpu_p99_ms",
]);
const ms = (n: number) => `${Number(n.toFixed(1))} ms`;

function CpuCard({ metrics }: { metrics: Metric[] }) {
  const hitsM = metrics.find((m) => m.key === "cpu_limit_hits");
  const p99M = metrics.find((m) => m.key === "cpu_p99_ms");
  if (!hitsM && !p99M) return null;
  const idle = metrics.every((m) => !(m.used > 0));
  return (
    <section className="oa-card oa-cpu" aria-labelledby="oa-cpu-h">
      <div className="oa-cpu-head">
        <h2 id="oa-cpu-h">CPU</h2>
        <span>A per-request limit, not a daily quota</span>
      </div>
      <div className="oa-cpu-rows">
        {hitsM && <HitsRow hits={Math.max(hitsM.used, 0)} />}
        {p99M && <P99Row metric={p99M} idle={idle} />}
      </div>
    </section>
  );
}

function HitsRow({ hits }: { hits: number }) {
  return (
    <div className="oa-cpu-row" data-tone={hits >= 3 ? "warning" : "normal"}>
      <h3>Requests over the CPU limit today</h3>
      <div className="oa-cpu-big">{fmt(hits)}</div>
      <p>
        {hits > 0
          ? "These requests were stopped with Cloudflare error 1102. Retrying usually works."
          : "No request was stopped for using too much CPU."}
      </p>
    </div>
  );
}

function P99Row({ metric, idle }: { metric: Metric; idle: boolean }) {
  const used = Math.max(metric.used, 0);
  const { limit } = metric;
  const pct = percent(used, limit);
  // A limit of 0 means no per-request cap to measure against (Workers Paid).
  const tone: Tone =
    limit > 0 && pct >= 100
      ? "danger"
      : limit > 0 && pct >= 80
        ? "warning"
        : "normal";
  return (
    <div className="oa-cpu-row">
      <h3>Typical busy request (p99)</h3>
      {idle ? (
        <div className="oa-cpu-big">
          <small>No requests yet today</small>
        </div>
      ) : (
        <>
          <div className="oa-cpu-big">
            {ms(used)} {limit > 0 && <small>of {ms(limit)}</small>}
          </div>
          {limit > 0 && (
            // biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled per tone cross-browser
            <div
              className="oa-track oa-thin"
              role="meter"
              aria-label="p99 CPU time"
              aria-valuemin={0}
              aria-valuemax={limit}
              aria-valuenow={Math.min(used, limit)}
              aria-valuetext={`${ms(used)} of ${ms(limit)}`}
              data-tone={tone}
            >
              <i style={{ width: `${Math.min(pct, 100)}%` }} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The plan positioning line, for the people who can change the plan. */
function PlanLine() {
  const me = useMe();
  const role = me.status === "authed" ? me.me.user.role : null;
  if (role !== "owner" && role !== "admin") return null;
  return (
    <p className="oa-plan-line">
      Workers Free is sized for one person. Workers Paid ($5 a month) is sized
      for a team: it sends invite emails and gives each request up to 30 seconds
      of CPU.{" "}
      <a href={COSTS_DOC} target="_blank" rel="noopener noreferrer">
        Compare plans
        {ExtIcon}
      </a>
    </p>
  );
}

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
      <PlanLine />
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
          {alerts(q.data.metrics.filter((m) => !CPU_KEYS.has(m.key)))}
          <p className="oa-seen">
            Today, {q.data.date}. Resets at 00:00 UTC. Cloudflare's numbers are
            cached for 5 minutes.
          </p>
          <div className="oa-meters">
            {q.data.metrics
              .filter((m) => !CPU_KEYS.has(m.key))
              .map((m) => (
                <Meter key={m.key} metric={m} />
              ))}
          </div>
          <CpuCard metrics={q.data.metrics} />
        </>
      )}
    </div>
  );
}
