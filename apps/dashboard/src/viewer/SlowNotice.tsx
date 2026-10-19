import { Banner, Button } from "@oa/ui";
import { ExtIcon } from "../layout/CpuBanner";
import { CPU_DOC, PLANS_URL } from "../layout/cpu";

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

/** After this many reloads the CPU variant mentions Workers Paid. */
export const UPSELL_AFTER = 2;

/**
 * The frame never said hello. The shell can't prove the artifact failed (one that
 * rewrites its own document never says hello), so this hints above the frame and
 * leaves the artifact visible. `cpu` only when a CPU-limit hit is likely.
 */
export function SlowNotice({
  cpu,
  reloads,
  admin,
  onReload,
  onDismiss,
}: {
  cpu: boolean;
  reloads: number;
  admin: boolean;
  onReload: () => void;
  onDismiss: () => void;
}) {
  const upsell = cpu && reloads >= UPSELL_AFTER;
  return (
    <div className="oa-vnotice">
      <Banner
        tone="info"
        compact
        icon={AlertIcon}
        onDismiss={onDismiss}
        action={
          <span className="oa-vnotice-acts">
            {upsell && admin && (
              <a
                className="oa-btn oa-sm"
                href={PLANS_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                See plans
                {ExtIcon}
              </a>
            )}
            <Button size="sm" icon={RetryIcon} onClick={onReload}>
              Reload
            </Button>
          </span>
        }
      >
        <span className="oa-vnotice-text">
          {cpu ? (
            <>
              This artifact may have hit your instance's CPU limit. Reloading
              usually works.
              {upsell && " Workers Paid raises the limit."}{" "}
              <a href={CPU_DOC} target="_blank" rel="noopener noreferrer">
                Learn more<span className="oa-sr"> about the CPU limit</span>
              </a>
            </>
          ) : (
            "This artifact hasn't responded yet. If it looks wrong, reload it."
          )}
        </span>
      </Banner>
    </div>
  );
}
