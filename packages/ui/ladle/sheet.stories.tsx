import { type CSSProperties, type ReactNode, useState } from "react";
import {
  AppShell,
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  type Format,
  FormatIcon,
  Input,
  Kbd,
  NavItem,
  SegmentedControl,
  Select,
  Skeleton,
  Tabs,
  type Visibility,
  VisibilityBadge,
} from "../src/index";
import { Themes } from "./Themes";

const ic = (d: string, size = 16) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flex: "none" }}
  >
    <path d={d} />
  </svg>
);
const icons = {
  library: ic("M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"),
  recent: ic("M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zM8 4.5V8l2.5 1.5"),
  trash: ic("M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"),
  plus: ic("M8 3v10M3 8h10", 14),
  grid: ic("M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z", 14),
  list: ic("M2 4h12M2 8h12M2 12h12", 14),
  inbox: ic("M2 9.5 4 3h8l2 6.5v3.5H2zM2 9.5h3.5l1 1.5h3l1-1.5H14", 20),
};

const artifacts: {
  title: string;
  format: Format;
  agent: string;
  owner: [string, string];
  visibility: Visibility;
  when: string;
}[] = [
  {
    title: "Q4 data migration plan",
    format: "markdown",
    agent: "Claude Code",
    owner: ["Maya Chen", "maya@northwind.dev"],
    visibility: "team",
    when: "2h ago",
  },
  {
    title: "Offsite location poll",
    format: "html",
    agent: "ChatGPT",
    owner: ["Priya Raman", "priya@northwind.dev"],
    visibility: "team",
    when: "35m ago",
  },
  {
    title: "Vendor MSA — redlined.pdf",
    format: "pdf",
    agent: "Codex CLI",
    owner: ["Dan Okafor", "dan@northwind.dev"],
    visibility: "private",
    when: "Yesterday",
  },
  {
    title: "backfill_shipped_at.py",
    format: "code",
    agent: "Cursor",
    owner: ["Maya Chen", "maya@northwind.dev"],
    visibility: "private",
    when: "4h ago",
  },
  {
    title: "Billing webhook retries — postmortem",
    format: "markdown",
    agent: "OpenCode",
    owner: ["Sam Reyes", "sam@northwind.dev"],
    visibility: "team",
    when: "Mon",
  },
  {
    title: "Onboarding flow v3 prototype",
    format: "html",
    agent: "Cursor",
    owner: ["Lena Vogel", "lena@northwind.dev"],
    visibility: "public",
    when: "Oct 9",
  },
];

const line = (width: string, color = "var(--oa-divider)"): CSSProperties => ({
  height: 4,
  width,
  borderRadius: 2,
  background: color,
  marginBottom: 5,
});

function ArtifactCard({ a }: { a: (typeof artifacts)[number] }) {
  return (
    <Card>
      <div
        style={{
          height: 104,
          boxSizing: "border-box",
          overflow: "hidden",
          padding: "14px 16px 0",
          background: "var(--oa-surface-2)",
          borderBottom: "1px solid var(--oa-divider)",
        }}
      >
        <div
          style={{
            height: "100%",
            boxSizing: "border-box",
            padding: 12,
            background: "var(--oa-surface)",
            borderRadius: "4px 4px 0 0",
            boxShadow: "0 0 0 1px var(--oa-divider)",
          }}
        >
          <div
            style={{
              ...line("62%", "var(--oa-text-2)"),
              height: 7,
              marginBottom: 8,
            }}
          />
          <div style={line("100%")} />
          <div style={line("88%")} />
          <div style={line("70%")} />
        </div>
      </div>
      <div style={{ padding: "10px 12px 11px", display: "grid", gap: 7 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontWeight: 500,
            minWidth: 0,
          }}
        >
          <span style={{ color: "var(--oa-text-muted)", display: "flex" }}>
            <FormatIcon format={a.format} decorative />
          </span>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {a.title}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "4px 8px",
            color: "var(--oa-text-muted)",
            fontSize: "var(--oa-text-xs)",
          }}
        >
          {/* Agent ellipsizes; the time wraps below when it's tight. */}
          <div
            style={{
              flex: "1 1 150px",
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Avatar name={a.owner[0]} email={a.owner[1]} />
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {a.agent}
            </span>
            <VisibilityBadge visibility={a.visibility} />
          </div>
          <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
            {a.when}
          </span>
        </div>
      </div>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: "var(--oa-text-md)", fontWeight: 600 }}>
        {title}
      </h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        }}
      >
        {children}
      </div>
    </section>
  );
}

const scopes = (
  [
    ["all", "All", 214],
    ["mine", "Mine", 63],
    ["shared", "Shared with me", 88],
    ["team", "Team", 131],
  ] as const
).map(([id, label, n]) => ({
  id,
  label: (
    <>
      {label} <Badge>{n}</Badge>
    </>
  ),
  content: null,
}));

function Library() {
  const [agent, setAgent] = useState<string>("any");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  return (
    <AppShell
      nav={
        <div style={{ display: "grid", gap: 1 }}>
          <div
            style={{ padding: "4px 6px 12px", fontWeight: 600, fontSize: 14 }}
          >
            Open Artifacts
          </div>
          <NavItem
            href="#library"
            icon={icons.library}
            label="Library"
            count={214}
            active
          />
          <NavItem href="#recent" icon={icons.recent} label="Recent" />
          <NavItem href="#trash" icon={icons.trash} label="Trash" />
        </div>
      }
      header={
        <>
          <div
            style={{
              flex: 1,
              maxWidth: 520,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Input
              aria-label="Search"
              placeholder="Search titles, content, and agents"
            />
            <Kbd>⌘K</Kbd>
          </div>
          <Button icon={icons.plus} style={{ marginLeft: "auto" }}>
            Upload
          </Button>
        </>
      }
    >
      <div
        style={{
          padding: "20px 24px 40px",
          display: "grid",
          // minmax(0, …) lets the column shrink below its content's width.
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: "-0.02em",
            }}
          >
            Library
          </h1>
          <span style={{ color: "var(--oa-text-muted)" }}>214 artifacts</span>
        </div>
        <Tabs tabs={scopes} />
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div style={{ width: 180 }}>
            <Select
              aria-label="Agent"
              value={agent}
              onChange={setAgent}
              options={[
                { value: "any", label: "Any agent" },
                { value: "claude", label: "Claude Code" },
                { value: "codex", label: "Codex CLI" },
                { value: "cursor", label: "Cursor" },
              ]}
            />
          </div>
          <span
            style={{
              color: "var(--oa-text-muted)",
              fontSize: "var(--oa-text-xs)",
            }}
          >
            Showing 6 of 214
          </span>
          <div style={{ flex: 1 }} />
          <SegmentedControl
            aria-label="Layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: "grid", label: "Grid", icon: icons.grid },
              { value: "list", label: "List", icon: icons.list },
            ]}
          />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fill, minmax(min(220px, 100%), 1fr))",
            gap: 14,
          }}
        >
          {artifacts.map((a) => (
            <ArtifactCard key={a.title} a={a} />
          ))}
        </div>
      </div>
    </AppShell>
  );
}

export const ComponentSheet = () => (
  <Themes>
    <div style={{ width: "100%", display: "grid", gap: 28 }}>
      <div
        style={{
          height: 720,
          overflow: "auto",
          borderRadius: 8,
          boxShadow: "var(--oa-shadow-1)",
        }}
      >
        <Library />
      </div>
      <Section title="Buttons">
        <Button variant="primary" icon={icons.plus}>
          New
        </Button>
        <Button>Share</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="danger">Delete</Button>
        <Button size="sm">Small</Button>
        <Button size="sm" variant="primary">
          Small primary
        </Button>
        <Button loading>Saving</Button>
      </Section>
      <Section title="Badges">
        {(["neutral", "accent", "success", "warning", "danger"] as const).map(
          (t) => (
            <Badge key={t} tone={t}>
              {t}
            </Badge>
          ),
        )}
        {(["private", "team", "public"] as const).map((v) => (
          <VisibilityBadge key={v} visibility={v} />
        ))}
      </Section>
      <Section title="Banners">
        <div style={{ width: "100%", display: "grid", gap: 8 }}>
          <Banner
            tone="danger"
            title="Quota reached"
            action={<Button size="sm">View usage</Button>}
          >
            Daily free-plan limit reached; resets at 00:00 UTC
          </Banner>
          <Banner tone="warning" title="Storage at 90%">
            Older versions will be pruned soon.
          </Banner>
          <Banner tone="success" title="Agent connected">
            Claude Code can now publish artifacts.
          </Banner>
          <Banner tone="info" title="New version">
            v8 of Q4 data migration plan is available.
          </Banner>
        </div>
      </Section>
      <Section title="Empty state">
        <Card style={{ width: "100%" }}>
          <EmptyState
            icon={icons.inbox}
            title="No artifacts yet"
            description="Connect an agent and publish your first artifact."
            action={<Button variant="primary">Connect an agent</Button>}
          />
        </Card>
      </Section>
      <Section title="Kbd and Skeleton">
        <Kbd>⌘K</Kbd>
        <Kbd>Esc</Kbd>
        <div style={{ display: "grid", gap: 6, width: 240 }}>
          <Skeleton width="60%" />
          <Skeleton />
          <Skeleton width="80%" />
        </div>
      </Section>
    </div>
  </Themes>
);
ComponentSheet.storyName = "Component sheet";
