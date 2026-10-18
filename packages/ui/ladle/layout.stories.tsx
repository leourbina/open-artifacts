import { AppShell, Banner, Button, EmptyState } from "../src/index";
import { Themes } from "./Themes";

const box = (
  <svg
    viewBox="0 0 16 16"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    aria-hidden="true"
  >
    <rect x="2" y="2" width="12" height="12" rx="2" />
  </svg>
);

export const Banners = () => (
  <Themes>
    {(["info", "success", "warning", "danger"] as const).map((tone) => (
      <div key={tone} style={{ width: "100%" }}>
        <Banner
          tone={tone}
          title="Storage at 90%"
          action={<Button size="sm">Manage</Button>}
        >
          Older versions will be pruned when the quota is reached.
        </Banner>
      </div>
    ))}
  </Themes>
);

export const Empty = () => (
  <Themes>
    <EmptyState
      icon={box}
      title="No artifacts yet"
      description="Connect an agent and publish your first artifact."
      action={<Button variant="primary">Connect an agent</Button>}
    />
  </Themes>
);

export const Shell = () => (
  <Themes>
    <div style={{ width: "100%", height: 360, overflow: "hidden" }}>
      <AppShell
        nav={<a href="#library">Library</a>}
        header={<strong>Library</strong>}
      >
        <div style={{ padding: 20 }}>Content</div>
      </AppShell>
    </div>
  </Themes>
);
