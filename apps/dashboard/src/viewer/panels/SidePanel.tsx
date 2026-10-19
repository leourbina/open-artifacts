import type { ArtifactSummary } from "@oa/shared";
import {
  Button,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import { useEffect, useRef } from "react";
import { ICON, TXT } from "../ui";
import { Details } from "./Details";
import { Share } from "./Share";
import { Versions } from "./Versions";

export const PANEL_TABS = ["versions", "share", "details"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];
export const isPanelTab = (t: unknown): t is PanelTab =>
  PANEL_TABS.includes(t as PanelTab);

const LABELS: Record<PanelTab, string> = {
  versions: "Versions",
  share: "Share",
  details: "Details",
};

/** Focus moved in on open is programmatic, so :focus-visible may not match. */
const PROGRAMMATIC =
  "data-[focus=programmatic]:focus:outline-2 data-[focus=programmatic]:focus:outline-offset-2 data-[focus=programmatic]:focus:outline-solid data-[focus=programmatic]:focus:outline-ring";

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
  // Focus moves to the active tab on open (the container itself shows no ring)
  // and back to whatever opened the panel on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const target =
      ref.current?.querySelector<HTMLElement>(
        '[role="tab"][data-state="active"]',
      ) ?? ref.current;
    if (target) {
      target.dataset.focus = "programmatic";
      target.addEventListener("blur", () => delete target.dataset.focus, {
        once: true,
      });
      target.focus();
    }
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      // Below 960px the panel covers the frame.
      className="relative box-border flex w-[353px] flex-none flex-col overflow-hidden border-0 border-l border-solid border-l-[var(--oa-border)] bg-card outline-none max-[959.98px]:absolute max-[959.98px]:inset-0 max-[959.98px]:z-10 max-[959.98px]:w-auto max-[959.98px]:border-l-0"
      aria-label="Side panel"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) onClose();
      }}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-xs"
              className={`absolute top-2 right-2 z-10 size-7 ${ICON} ${TXT}`}
              aria-label="Close panel"
              onClick={onClose}
            >
              ×
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close panel</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:!block">
        <div className="p-4">
          <Tabs value={tab} onValueChange={(t) => isPanelTab(t) && onTab(t)}>
            <TabsList
              variant="line"
              className="h-auto w-full justify-start gap-1 border-0 border-b border-solid border-border p-0 pr-9"
            >
              {PANEL_TABS.map((t) => (
                <TabsTrigger
                  key={t}
                  value={t}
                  className={`h-[34px] flex-none rounded-sm px-3 ${TXT} ${PROGRAMMATIC}`}
                >
                  {LABELS[t]}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="versions">
              <Versions artifact={artifact} />
            </TabsContent>
            <TabsContent value="share">
              <Share artifact={artifact} />
            </TabsContent>
            <TabsContent value="details">
              <Details artifact={artifact} />
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </aside>
  );
}
