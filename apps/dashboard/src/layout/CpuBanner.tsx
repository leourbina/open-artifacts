import type { Me } from "@oa/shared";
import { Banner, IconButton } from "@oa/ui";
import { useState } from "react";
import { CPU_DOC, PLANS_URL, useCpuSignals } from "./cpu";

const DISMISSED_KEY = "oa.cpuBanner.dismissed";

const read = () => {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
};

const XIcon = (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);
export const ExtIcon = (
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
    <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4" />
  </svg>
);
export const DismissButton = ({ onClick }: { onClick: () => void }) => (
  <IconButton label="Dismiss" icon={XIcon} size="sm" onClick={onClick} />
);

/**
 * Today's CPU-limit hits (3 or more), or a 1102 this tab just got. Dismissed for the
 * rest of the UTC day; gone on its own once today's count is back to 0.
 */
export function CpuBanner({ role }: { role: Me["user"]["role"] | undefined }) {
  const { admin, hits, recent, today } = useCpuSignals(role);
  const [dismissed, setDismissed] = useState(read);
  const n = hits ?? 0;
  if (role === "guest" || dismissed === today || !(n >= 3 || recent))
    return null;
  const first =
    n > 0
      ? `Your instance hit the limit ${n} ${n === 1 ? "time" : "times"} today, usually from bursts of large publishes.`
      : "A request just hit Cloudflare's free CPU limit.";
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, today);
    } catch {}
    setDismissed(today);
  };
  return (
    <div className="oa-cpu-banner">
      <Banner
        tone="warning"
        title="Some requests hit Cloudflare's free CPU limit"
        action={<DismissButton onClick={dismiss} />}
      >
        <p>
          {first} Retrying generally works. Workers Paid ($5 a month) raises the
          limit to 30 seconds.
          {!admin && " Ask your instance owner about upgrading."}
        </p>
        <div className="oa-cpu-acts">
          {admin && (
            <a
              className="oa-btn oa-sm oa-primary"
              href={PLANS_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              See plans
              {ExtIcon}
            </a>
          )}
          <a
            className="oa-cpu-link"
            href={CPU_DOC}
            target="_blank"
            rel="noopener noreferrer"
          >
            Learn more<span className="oa-sr"> about the CPU limit</span>
          </a>
        </div>
      </Banner>
    </div>
  );
}
