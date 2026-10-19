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
import { SM } from "../ui";
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
      // Below 960px the panel covers the frame. Focus moved here on open is
      // programmatic, so :focus-visible may not match; data-focus covers it.
      className="relative box-border flex w-[353px] flex-none flex-col overflow-hidden border-0 border-l border-solid border-border bg-card focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring data-[focus=programmatic]:focus:outline-2 data-[focus=programmatic]:focus:-outline-offset-2 data-[focus=programmatic]:focus:outline-solid data-[focus=programmatic]:focus:outline-ring max-[959.98px]:absolute max-[959.98px]:inset-0 max-[959.98px]:z-10 max-[959.98px]:w-auto max-[959.98px]:border-l-0"
      aria-label="Side panel"
      onBlur={(e) => {
        if (e.target === e.currentTarget) delete e.currentTarget.dataset.focus;
      }}
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
              className={`absolute top-2 right-2 z-10 size-7 ${SM}`}
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
                  className={`h-[34px] flex-none rounded-sm px-3 ${SM}`}
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
