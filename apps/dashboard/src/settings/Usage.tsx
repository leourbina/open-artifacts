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
};
const BADGE = {
  normal: "neutral",
  warning: "warning",
  danger: "danger",
} as const;

/** Raw percent of the limit; a limit of 0 (or less) counts as 0, never NaN. */
export const percent = (used: number, limit: number) =>
  limit > 0 && used > 0 ? (used / limit) * 100 : 0;
export const toneOf = (pct: number): Tone =>
  pct >= 95 ? "danger" : pct >= 80 ? "warning" : "normal";
const fmt = (n: number) => n.toLocaleString("en-US");

function Meter({ metric }: { metric: Metric }) {
  const { name, what } = LABELS[metric.key];
  const pct = percent(metric.used, metric.limit);
  const tone = toneOf(pct);
  const shown = pct > 100 ? "100%+" : `${Math.floor(pct)}%`;
  const left = Math.max(metric.limit - metric.used, 0);
  return (
    <section className="oa-card oa-meter" data-tone={tone} aria-label={name}>
      <div className="oa-meter-head">
        <h2>{name}</h2>
        <Badge tone={BADGE[tone]}>
          {tone === "danger" ? `${shown} · near limit` : shown}
        </Badge>
      </div>
      <div className="oa-meter-value">
        <b>{fmt(metric.used)}</b>
        <span>/ {fmt(metric.limit)} today</span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot be styled per tone cross-browser */}
      <div
        className="oa-track"
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={metric.limit}
        aria-valuenow={metric.used}
        aria-valuetext={`${fmt(metric.used)} of ${fmt(metric.limit)}`}
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

export function Usage() {
  useDocumentTitle("Usage");
  const q = useUsage();
  return (
    <div className="oa-settings oa-usage">
      <div className="oa-usage-head">
        <h1>Usage</h1>
        <Badge>Workers Free plan</Badge>
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
          <p className="oa-seen">
            Today, {q.data.date}. Resets at 00:00 UTC. Cloudflare's numbers are
            cached for 5 minutes.
          </p>
          <div className="oa-meters">
            {q.data.metrics.map((m) => (
              <Meter key={m.key} metric={m} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
