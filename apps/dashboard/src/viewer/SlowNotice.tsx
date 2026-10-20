import { Button } from "@oa/ui/shadcn";
import { ExtIcon } from "../layout/CpuBanner";
import { CPU_DOC, PLANS_URL } from "../layout/cpu";
import { ICON, LINK_BTN, SM } from "./ui";

const svg = (d: string) => (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const AlertIcon = svg("M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.8v3.7M8 11v.2");
const RetryIcon = svg("M13 3.5v3h-3M13 6.5A5 5 0 1 0 13.4 10");
const DismissIcon = svg("M4 4l8 8M12 4l-8 8");

/** After this many reloads the CPU variant mentions Workers Paid. */
export const UPSELL_AFTER = 2;

/**
 * The frame never said hello. The shell can't prove the artifact failed (one that
 * rewrites its own document never says hello), so this hints above the frame and
 * leaves the artifact visible. `cpu` only when a CPU-limit hit is likely.
 */
export function SlowNotice({
  cpu,
  paid = false,
  reloads,
  admin,
  onReload,
  onDismiss,
}: {
  cpu: boolean;
  /** Workers Paid: the 30-second limit, nothing to upgrade to. */
  paid?: boolean;
  reloads: number;
  admin: boolean;
  onReload: () => void;
  onDismiss: () => void;
}) {
  // Only the people who can change the plan are pointed at it.
  const upsell = cpu && !paid && admin && reloads >= UPSELL_AFTER;
  return (
    <div className="oa-vnotice mx-auto my-3 w-[calc(100%-32px)] max-w-[680px]">
      <div
        role="status"
        className="flex items-center gap-2 rounded-md bg-[var(--oa-accent-soft)] py-1 pr-1 pl-3 text-[length:var(--oa-text-sm)] leading-[1.45] text-foreground max-[560px]:flex-wrap"
      >
        <span
          className="inline-flex flex-none text-[var(--oa-accent-fg)]"
          aria-hidden="true"
        >
          {AlertIcon}
        </span>
        <div className="min-w-0 flex-1 max-[560px]:basis-[calc(100%-60px)]">
          <span className="oa-vnotice-text [&_a]:font-medium [&_a]:whitespace-nowrap [&_a]:text-foreground [&_a]:underline-offset-2">
            {cpu && paid ? (
              "This request hit Cloudflare's 30-second CPU limit. Try again."
            ) : cpu ? (
              <>
                This artifact may have hit your instance's CPU limit. Reloading
                usually works.
                {upsell && " Workers Paid raises the limit."}{" "}
                <a href={CPU_DOC} target="_blank" rel="noopener noreferrer">
                  Learn more
                  <span className="sr-only"> about the CPU limit</span>
                </a>
              </>
            ) : (
              "This artifact hasn't responded yet. If it looks wrong, reload it."
            )}
          </span>
        </div>
        <span className="flex flex-none items-center gap-[6px] max-[560px]:ml-[22px]">
          {upsell && (
            <Button asChild variant="outline" size="xs" className={LINK_BTN}>
              <a href={PLANS_URL} target="_blank" rel="noopener noreferrer">
                See plans
                {ExtIcon}
              </a>
            </Button>
          )}
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
