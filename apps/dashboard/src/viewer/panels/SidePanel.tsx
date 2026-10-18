import type { ArtifactSummary } from "@oa/shared";
import { Tabs } from "@oa/ui";
import { Versions } from "./Versions";

export const PANEL_TABS = ["versions", "share", "details"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];
export const isPanelTab = (t: unknown): t is PanelTab =>
  PANEL_TABS.includes(t as PanelTab);

export function SidePanel({
  artifact,
  tab,
  onTab,
  onClose,
}: {
  artifact: ArtifactSummary;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
}) {
  return (
    <aside className="oa-vpanel" aria-label="Side panel">
      <button
        type="button"
        className="oa-btn oa-vpanel-close"
        aria-label="Close panel"
        onClick={onClose}
      >
        ×
      </button>
      <Tabs
        value={tab}
        onValueChange={(t) => isPanelTab(t) && onTab(t)}
        tabs={[
          {
            id: "versions",
            label: "Versions",
            content: <Versions artifact={artifact} />,
          },
          {
            id: "share",
            label: "Share",
            // TODO(FE6): replace with the real Share panel.
            content: <p>Sharing settings are coming soon.</p>,
          },
          {
            id: "details",
            label: "Details",
            // TODO(FE6): replace with the real Details panel.
            content: <p>Details are coming soon.</p>,
          },
        ]}
      />
    </aside>
  );
}
