import type { InstanceUpdate } from "@oa/shared";
import { type ComponentProps, forwardRef, type MouseEvent } from "react";
import { ArrowIcon, BreakingNote, LINK, UpgradeActions, v } from "./update";

/** The dot on the chip and on the phone menu trigger: accent, or warning for a breaking release. */
export function UpdateDot({
  breaking,
  ring = "soft",
  className = "",
}: {
  breaking: boolean;
  /** soft: the chip's 3px tinted ring; page: a 2px ring in the page color (on the trigger). */
  ring?: "soft" | "page";
  className?: string;
}) {
  const color = breaking ? "var(--oa-warning)" : "var(--oa-accent)";
  const halo =
    ring === "soft"
      ? `0 0 0 3px ${breaking ? "var(--oa-warning-soft)" : "var(--oa-accent-soft)"}`
      : "0 0 0 2px var(--oa-bg)";
  return (
    <span
      aria-hidden="true"
      className={`block size-2 flex-none rounded-full ${className}`}
      style={{ background: color, boxShadow: halo }}
    />
  );
}

/** Sidebar footer chip (Design's A): dot, "Update available", the new version. */
export const UpdateChipButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<"button"> & { update: InstanceUpdate }
>(function UpdateChipButton({ update, className = "", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-[var(--oa-radius-md)] border border-solid border-[var(--oa-divider)] bg-[var(--oa-surface)] px-2 text-left font-[inherit] text-[13px] text-[var(--oa-text)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--oa-focus)] aria-expanded:border-[var(--oa-border-strong)] ${className}`}
      {...rest}
    >
      <UpdateDot breaking={update.breaking === true} />
      Update available
      <span className="ml-auto font-mono text-[12px] text-[var(--oa-accent-fg)]">
        {v(update.latestVersion)}
      </span>
    </button>
  );
});

/** The popover's body: versions, the breaking note, Upgrade, Release notes, Details in Settings. */
export function UpdatePanel({
  update,
  onSettings,
}: {
  update: InstanceUpdate;
  onSettings: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <div className="grid gap-[10px]">
      <h3 className="m-0 text-[14px] font-semibold">Update available</h3>
      <p className="m-0 flex items-center gap-2 font-mono text-[13px] text-[var(--oa-text-2)]">
        <span className="font-semibold text-[var(--oa-text)]">
          {v(update.current)}
        </span>
        <ArrowIcon />
        <span className="sr-only">to</span>
        <span className="font-semibold text-[var(--oa-accent-fg)]">
          {v(update.latestVersion)}
        </span>
      </p>
      <p id="oa-chip-upgrade-help" className="sr-only">
        Upgrade copies a prompt. Paste it into any AI agent to run the upgrade.
      </p>
      <BreakingNote update={update} />
      <UpgradeActions
        update={update}
        describedBy="oa-chip-upgrade-help"
        compact
      />
      <a
        className={`${LINK} text-[12px]`}
        href="/settings/instance"
        onClick={onSettings}
      >
        Details in Settings
      </a>
    </div>
  );
}
