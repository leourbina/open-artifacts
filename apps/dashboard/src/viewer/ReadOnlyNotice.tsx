import { svg } from "./SlowNotice";

const InfoIcon = svg("M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 7.2v3.7M8 5v.2");

/**
 * The caller can't write this artifact's live data (`can.dataWrite` false:
 * a guest or a restricted member). The renav notice's banner, without
 * actions. Decided (D10): the "View only" chip and hidden buttons in the
 * title bar, plus this notice for guests and contractors on live-data
 * artifacts.
 */
export function ReadOnlyNotice() {
  return (
    <div className="oa-vnotice oa-vreadonly mx-auto my-3 w-[calc(100%-32px)] max-w-[680px]">
      <div
        role="status"
        className="flex items-center gap-2 rounded-md bg-[var(--oa-accent-soft)] px-3 py-[6px] text-[length:var(--oa-text-sm)] leading-[1.45] text-foreground"
      >
        <span
          className="inline-flex flex-none text-[var(--oa-accent-fg)]"
          aria-hidden="true"
        >
          {InfoIcon}
        </span>
        <div className="min-w-0 flex-1">
          You can view this, but not change it.
        </div>
      </div>
    </div>
  );
}
