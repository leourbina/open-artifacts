import type { ArtifactSummary } from "@oa/shared";
import { Tabs } from "@oa/ui";
import { useEffect, useRef } from "react";
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
  const ref = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Focus moves in on open and back to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Marks this focus as programmatic so the ring shows even after a pointer open.
    if (ref.current) ref.current.dataset.focus = "programmatic";
    ref.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      className="oa-vpanel"
      aria-label="Side panel"
      onBlur={(e) => {
        if (e.target === e.currentTarget) delete e.currentTarget.dataset.focus;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) onClose();
      }}
    >
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
