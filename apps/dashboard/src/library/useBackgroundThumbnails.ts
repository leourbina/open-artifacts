import { type ArtifactSummary, ContentUrlSchema, R } from "@oa/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../api/client";
import { createBridge } from "../viewer/bridge";
import { BACKGROUND_SANDBOX, safeContentUrl } from "../viewer/frame";
import {
  invalidateThumbnail,
  thumbAsked,
  uploadThumbnail,
} from "../viewer/useArtifactSideEffects";
import { currentTheme } from "../viewer/useTheme";

const MAX_ATTEMPTS = 12;
const TIMEOUT_MS = 10_000;
/** Only these renderers answer thumb.request; others would just time out. */
const SNAPSHOT_FORMATS = new Set(["html", "pdf"]);
/** No data, storage or viewer access for code no one opened. */
const NO_CAPABILITIES = { db: false, viewer: false, storage: false };
const ATTEMPTS_KEY = "oa.bgthumb.attempts";
const JOURNAL_KEY = "oa.bgthumb.journal";
/** A started attempt that never finished (a hang or a crash) is not retried for this long. */
const JOURNAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * WebKit runs cross-origin frames on the page's main thread, so a busy artifact
 * would freeze the library. That is Safari and every browser on iOS/iPadOS.
 */
export function isWebKit(
  ua = navigator.userAgent,
  touchPoints = navigator.maxTouchPoints ?? 0,
): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS asks for desktop sites with a Mac UA; Macs have no touch points.
  if (/Macintosh/.test(ua) && touchPoints > 1) return true;
  return (
    /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(ua)
  );
}

// Per session; in sessionStorage when available, so a reload keeps the count.
let memAttempts = 0;
const attemptsSoFar = () => {
  try {
    return Math.max(
      memAttempts,
      Number(sessionStorage.getItem(ATTEMPTS_KEY)) || 0,
    );
  } catch {
    return memAttempts;
  }
};
const setAttempts = (n: number) => {
  memAttempts = n;
  try {
    sessionStorage.setItem(ATTEMPTS_KEY, String(n));
  } catch {}
};

type Journal = Record<string, unknown>;
const readJournal = (): Journal => {
  try {
    const j = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? "{}");
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
};
const live = (t: unknown) =>
  typeof t === "number" && Date.now() - t < JOURNAL_TTL_MS;
const journaled = (id: string) => live(readJournal()[id]);
/** Records (or clears) a started attempt, dropping expired entries. */
const journal = (id: string, started: boolean) => {
  const j = readJournal();
  for (const k of Object.keys(j)) if (!live(j[k])) delete j[k];
  if (started) j[id] = Date.now();
  else delete j[id];
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(j));
  } catch {}
};

// Failed in the background this session. Kept apart from thumbAsked so the
// viewer, with real capabilities, can still make the thumbnail.
const bgFailed = new Set<string>();

const eligible = (a: ArtifactSummary) =>
  (a.access === "editor" || a.access === "owner") &&
  a.thumbnailUrl === null &&
  SNAPSHOT_FORMATS.has(a.format) &&
  !thumbAsked.has(a.id) &&
  !bgFailed.has(a.id) &&
  !journaled(a.id);

const saveData = () =>
  (navigator as { connection?: { saveData?: boolean } }).connection
    ?.saveData === true;

/** The user is typing somewhere: never start a frame that could take the focus. */
const typing = () => {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return false;
  return (
    /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ||
    el.isContentEditable ||
    el.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
};

/** ok: a thumbnail came back. cancel: stopped by us, not the artifact's fault. */
type Outcome = "ok" | "fail" | "timeout" | "focus" | "cancel";

/**
 * Renders `a` in a hidden frame and hands its snapshot to `onThumb`. Calls `done`
 * once with the outcome; the returned function cancels.
 */
function capture(
  a: ArtifactSummary,
  onThumb: (blob: Blob) => void,
  done: (o: Outcome) => void,
): () => void {
  const abort = new AbortController();
  let frame: HTMLIFrameElement | null = null;
  let bridge: ReturnType<typeof createBridge> | null = null;
  let over = false;
  // Where focus goes back to if the frame grabs it.
  let prev =
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : null;
  // A frame holding focus would receive the user's keystrokes: kill it.
  const guard = () =>
    setTimeout(() => {
      if (over || !frame || document.activeElement !== frame) return;
      // Focus back first, so nothing new starts while the user types.
      if (prev?.isConnected) prev.focus();
      finish("focus");
    }, 0);
  const onFocusIn = (e: FocusEvent) => {
    if (e.target !== frame && e.target instanceof HTMLElement) prev = e.target;
    guard();
  };
  const finish = (o: Outcome) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    abort.abort();
    window.removeEventListener("blur", guard);
    document.removeEventListener("focusin", onFocusIn);
    bridge?.dispose();
    frame?.remove();
    done(o);
  };
  const timer = setTimeout(() => finish("timeout"), TIMEOUT_MS);
  api.get(R.contentUrl(a.id), ContentUrlSchema, abort.signal).then(
    (c) => {
      if (over) return;
      const url = safeContentUrl(c.url);
      if (!url) return finish("fail");
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", BACKGROUND_SANDBOX);
      f.setAttribute("allow", "");
      f.setAttribute("referrerpolicy", "no-referrer");
      f.setAttribute("aria-hidden", "true");
      f.setAttribute("inert", "");
      f.tabIndex = -1;
      f.width = "1280";
      f.height = "800";
      // Transparent and behind the page rather than off-screen: Chromium stops
      // animation frames in off-screen cross-origin frames, so a snapshot never ends.
      Object.assign(f.style, {
        position: "fixed",
        left: "0",
        top: "0",
        zIndex: "-1",
        opacity: "0",
        width: "1280px",
        height: "800px",
        border: "0",
        pointerEvents: "none",
      });
      const b = createBridge({
        iframe: f,
        artifact: { ...a, capabilities: NO_CAPABILITIES },
        version: a.currentVersion,
        viewer: null,
        theme: currentTheme(),
        onPdfText: () => {},
        onHello: () => {
          if (!b.requestThumbnail()) finish("fail");
        },
        onThumb: (blob) => {
          onThumb(blob);
          finish("ok");
        },
      });
      frame = f;
      bridge = b;
      window.addEventListener("blur", guard);
      document.addEventListener("focusin", onFocusIn);
      // Before the frame runs anything: a hang or a tab crash stays recorded.
      journal(a.id, true);
      f.src = url;
      document.body.append(f);
    },
    (e) => {
      if (!over) console.debug("background thumbnail failed", e);
      finish("fail");
    },
  );
  return () => finish("cancel");
}

/**
 * Captures missing thumbnails for `items` the caller may edit, one hidden frame at
 * a time, at most MAX_ATTEMPTS per session, only while the tab is visible and the
 * user isn't typing. Never on WebKit.
 */
export function useBackgroundThumbnails(items: ArtifactSummary[]) {
  const qc = useQueryClient();
  const offer = useRef<(items: ArtifactSummary[]) => void>(() => {});

  useEffect(() => {
    if (isWebKit()) return;
    let latest: ArtifactSummary[] = [];
    let cancel: (() => void) | null = null;
    let stopped = false;
    const pump = () => {
      if (
        stopped ||
        cancel ||
        attemptsSoFar() >= MAX_ATTEMPTS ||
        document.visibilityState !== "visible" ||
        saveData() ||
        typing()
      )
        return;
      const a = latest.find(eligible);
      if (!a) return;
      setAttempts(attemptsSoFar() + 1);
      thumbAsked.add(a.id);
      cancel = capture(
        a,
        (blob) =>
          uploadThumbnail(a.id, blob, api.putBody, () =>
            invalidateThumbnail(qc, a.id),
          ),
        (o) => {
          cancel = null;
          if (o === "ok") journal(a.id, false);
          else {
            // Never block the viewer's own capture.
            thumbAsked.delete(a.id);
            if (o === "cancel") {
              journal(a.id, false);
              setAttempts(attemptsSoFar() - 1);
            } else {
              // timeout and focus keep their journal entry: no retry for a day.
              if (o === "fail") journal(a.id, false);
              bgFailed.add(a.id);
            }
          }
          pump();
        },
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") cancel?.();
      else pump();
    };
    // Typing may have ended.
    const onFocusOut = () => setTimeout(pump, 0);
    offer.current = (items) => {
      latest = items;
      pump();
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      stopped = true;
      offer.current = () => {};
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusout", onFocusOut);
      cancel?.();
    };
  }, [qc]);

  useEffect(() => offer.current(items), [items]);
}
