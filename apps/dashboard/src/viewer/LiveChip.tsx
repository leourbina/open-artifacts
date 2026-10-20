import { AUTH, viewerPath } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { svg } from "./SlowNotice";
import { SM } from "./ui";
import type { Gone, LiveUpdate, Swapped } from "./useLiveVersions";

/** Swapped notes: dashboard and phone; /full. Paused while hovered or focused. */
export const NOTE_MS = 8_000;
export const FULL_NOTE_MS = 3_000;
/** The /full pill shows widened this long on arrival, then collapses. */
export const PILL_REVEAL_MS = 4_000;

const RefreshIcon = (
  <svg
    viewBox="0 0 16 16"
    width="13"
    height="13"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" />
  </svg>
);

/**
 * Runs `onExpire` after `ms`, paused while the returned handlers' element is
 * hovered or focused (Design: swapped notes pause; held chips never hide).
 */
function usePausableTimer(ms: number, onExpire: () => void) {
  const left = useRef(ms);
  const started = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const holds = useRef(0);
  const cb = useRef(onExpire);
  cb.current = onExpire;
  const run = () => {
    if (holds.current > 0) return;
    started.current = Date.now();
    timer.current = setTimeout(() => cb.current(), Math.max(0, left.current));
  };
  const pause = () => {
    clearTimeout(timer.current);
    if (started.current !== null) left.current -= Date.now() - started.current;
    started.current = null;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount
  useEffect(() => {
    run();
    return pause;
  }, []);
  const hold = () => {
    holds.current++;
    pause();
  };
  const release = () => {
    holds.current = Math.max(0, holds.current - 1);
    if (started.current === null) run();
  };
  return {
    onPointerEnter: hold,
    onPointerLeave: release,
    onFocus: hold,
    onBlur: release,
  };
}

const heldLabel = (u: LiveUpdate) =>
  u.restoredFrom !== undefined
    ? { long: `v${u.restoredFrom} restored as current`, short: `v${u.version}` }
    : { long: `v${u.version} available`, short: `v${u.version}` };
const swappedLabel = (u: LiveUpdate) =>
  u.restoredFrom !== undefined
    ? { long: `v${u.restoredFrom} was restored as current`, short: "Updated" }
    : { long: `Updated to v${u.version}`, short: "Updated" };

/** Long copy from 640px up; Design's short phone copy below. */
const Copy = ({ long, short }: { long: string; short: string }) => (
  <>
    <span className="max-[639px]:hidden">{long}</span>
    <span className="min-[640px]:hidden">{short}</span>
  </>
);

function SwappedChip({
  swapped,
  onUndo,
  onExpire,
}: {
  swapped: Swapped;
  onUndo: () => void;
  onExpire: () => void;
}) {
  const pause = usePausableTimer(NOTE_MS, onExpire);
  return (
    <span className="oa-lchip oa-lchip-done" {...pause}>
      <Copy {...swappedLabel(swapped)} />
      <span className="oa-lchip-sep" aria-hidden="true" />
      <button
        type="button"
        className="oa-lchip-undo oa-hit"
        aria-label={`Undo, go back to version ${swapped.prev}`}
        onClick={onUndo}
      >
        Undo
      </button>
    </span>
  );
}

/**
 * The title bar's live slot, right after the version picker: held (vN
 * available · View), swapped (Updated to vN · Undo, for 8 s) or, on an
 * explicit older version, the quiet "Current is vN" hint.
 */
export function TitleLive({
  held,
  swapped,
  current,
  onView,
  onUndo,
  onCurrent,
  onExpire,
}: {
  held: LiveUpdate | null;
  swapped: Swapped | null;
  /** Set on a pinned older version: the current one. */
  current: number | null;
  onView: () => void;
  onUndo: () => void;
  onCurrent: () => void;
  onExpire: () => void;
}) {
  if (held)
    return (
      <span className="oa-lchip">
        <span className="oa-ldot" aria-hidden="true" />
        <Copy {...heldLabel(held)} />
        <span className="oa-lchip-sep" aria-hidden="true" />
        <Button
          size="xs"
          className="oa-lchip-view oa-hit"
          aria-label={`View version ${held.version}`}
          onClick={onView}
        >
          View
        </Button>
      </span>
    );
  if (swapped)
    return (
      <SwappedChip
        key={swapped.version}
        swapped={swapped}
        onUndo={onUndo}
        onExpire={onExpire}
      />
    );
  if (current !== null)
    return (
      <button
        type="button"
        className="oa-lchip oa-lchip-quiet oa-hit"
        onClick={onCurrent}
      >
        Current is v{current}
      </button>
    );
  return null;
}

/** A dot for Versions (and ••• on phones) while a newer version isn't shown. */
export const VersionsDot = () => (
  <span className="oa-vdot" aria-hidden="true" data-testid="versions-dot" />
);

function FullSwapped({
  swapped,
  onExpire,
}: {
  swapped: Swapped;
  onExpire: () => void;
}) {
  const pause = usePausableTimer(FULL_NOTE_MS, onExpire);
  return (
    <span className="oa-lpill oa-lpill-note" data-open="true" {...pause}>
      {swappedLabel(swapped).long}
    </span>
  );
}

/**
 * /full and embeds: a pill 8px left of the peek chip, in its recipe. Held:
 * widened 4 s on arrival, then a 32px circle (embeds rest collapsed); hover
 * and focus widen it. Embedded, it opens /a/<id> in a new tab.
 */
export function FullLive({
  id,
  title,
  embed,
  held,
  swapped,
  onView,
  onExpire,
}: {
  id: string;
  title: string;
  embed: boolean;
  held: LiveUpdate | null;
  swapped: Swapped | null;
  onView: () => void;
  onExpire: () => void;
}) {
  const [revealed, setRevealed] = useState(!embed);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const arrived = held !== null;
  useEffect(() => {
    if (!arrived || embed) return;
    setRevealed(true);
    const t = setTimeout(() => setRevealed(false), PILL_REVEAL_MS);
    return () => clearTimeout(t);
  }, [arrived, embed]);
  if (held) {
    const open = revealed || hover || focus;
    const label =
      held.restoredFrom !== undefined
        ? `v${held.restoredFrom} restored as current`
        : `v${held.version} available`;
    const props = {
      className: "oa-lpill",
      "data-open": open,
      onPointerEnter: () => setHover(true),
      onPointerLeave: () => setHover(false),
      onFocus: () => setFocus(true),
      onBlur: () => setFocus(false),
    };
    const inner = (action: string) => (
      <>
        <span className="oa-ldot" aria-hidden="true" />
        <span className="oa-lpill-icon" aria-hidden="true">
          {RefreshIcon}
        </span>
        <span className="oa-lpill-label">
          {label} · {action}
        </span>
      </>
    );
    return embed ? (
      <a
        {...props}
        href={new URL(viewerPath(id), location.origin).href}
        target="_blank"
        rel="noopener"
        aria-label={`Version ${held.version} available, open ${title} in a new tab`}
      >
        {inner("Open ↗")}
      </a>
    ) : (
      <button
        {...props}
        type="button"
        aria-label={`View version ${held.version}`}
        onClick={onView}
      >
        {inner("View")}
      </button>
    );
  }
  if (swapped && !embed)
    return (
      <FullSwapped
        key={swapped.version}
        swapped={swapped}
        onExpire={onExpire}
      />
    );
  return null;
}

/** /full when gone: the peek chip's replacement. A link out, except embedded. */
export function FullGone({ id, embed }: { id: string; embed: boolean }) {
  const dot = <span className="oa-lwdot" aria-hidden="true" />;
  return embed ? (
    <span className="oa-lpill oa-lpill-gone" data-open="true">
      {dot}
      No longer available
    </span>
  ) : (
    <Link
      to={viewerPath(id)}
      className="oa-lpill oa-lpill-gone"
      data-open="true"
    >
      {dot}
      No longer available · Exit
    </Link>
  );
}

const WarnIcon = svg("M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.8v3.7M8 11v.2");

/** Deleted or no access while open: the frame stays; a warning banner. */
export function GoneBanner({
  gone,
  authed,
  next,
}: {
  gone: Gone;
  authed: boolean;
  next: string;
}) {
  return (
    <div className="oa-lgone flex items-center gap-2 border-0 border-b border-border bg-[var(--oa-warning-soft)] px-5 py-[5px] text-[length:var(--oa-text-sm)] leading-[1.45] text-foreground max-[600px]:flex-wrap max-[600px]:px-4">
      <span
        className="inline-flex flex-none text-[var(--oa-warning)]"
        aria-hidden="true"
      >
        {WarnIcon}
      </span>
      <span className="min-w-0 flex-1">
        {gone === "deleted"
          ? "This artifact was deleted. You're seeing the copy already open in this tab."
          : "You no longer have access. The copy in this tab stays until you leave; live data is off."}
      </span>
      {gone === "deleted" ? (
        <Button
          asChild
          variant="outline"
          size="xs"
          className={`${SM} text-foreground hover:text-foreground`}
        >
          <Link to="/">Your artifacts</Link>
        </Button>
      ) : (
        !authed && (
          <Button
            asChild
            variant="outline"
            size="xs"
            className={`${SM} text-foreground hover:text-foreground`}
          >
            <a href={`${AUTH.login}?next=${encodeURIComponent(next)}`}>
              Sign in
            </a>
          </Button>
        )
      )}
    </div>
  );
}

/** The one polite status region, mounted empty on load. */
export const LiveAnnouncer = ({ text }: { text: string }) => (
  <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
    {text}
  </div>
);
