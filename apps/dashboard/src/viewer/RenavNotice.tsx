import { Button } from "@oa/ui/shadcn";
import { DismissIcon, RetryIcon, svg } from "./SlowNotice";
import { ICON, SM } from "./ui";

const InfoIcon = svg("M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 7.2v3.7M8 5v.2");

/**
 * The frame navigated somewhere the shell didn't send it, so its bridge is
 * gone (#306). Shown only for artifacts with live data; Reload goes back to
 * the entry page with a fresh nonce. The slow notice's banner, in info tone.
 */
export function RenavNotice({
  onReload,
  onDismiss,
}: {
  onReload: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="oa-vnotice oa-vrenav mx-auto my-3 w-[calc(100%-32px)] max-w-[680px]">
      <div
        role="status"
        className="flex items-center gap-2 rounded-md bg-[var(--oa-accent-soft)] py-1 pr-1 pl-3 text-[length:var(--oa-text-sm)] leading-[1.45] text-foreground max-[560px]:flex-wrap"
      >
        <span
          className="inline-flex flex-none text-[var(--oa-accent-fg)]"
          aria-hidden="true"
        >
          {InfoIcon}
        </span>
        <div className="min-w-0 flex-1 max-[560px]:basis-[calc(100%-60px)]">
          Live data is off on this page because it opened from a link inside the
          artifact. Reload to go back to the first page and reconnect.
        </div>
        <span className="flex flex-none items-center gap-[6px] max-[560px]:ml-[22px]">
          <Button variant="outline" size="xs" className={SM} onClick={onReload}>
            {RetryIcon}
            Reload
          </Button>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className={`flex-none ${ICON}`}
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          {DismissIcon}
        </Button>
      </div>
    </div>
  );
}
