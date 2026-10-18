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

// Per session, across remounts.
let attempts = 0;

const eligible = (a: ArtifactSummary) =>
  (a.access === "editor" || a.access === "owner") &&
  a.thumbnailUrl === null &&
  SNAPSHOT_FORMATS.has(a.format) &&
  !thumbAsked.has(a.id);

const saveData = () =>
  (navigator as { connection?: { saveData?: boolean } }).connection
    ?.saveData === true;

/**
 * Renders `a` in an off-screen frame and uploads its snapshot. Calls `done` once,
 * on success, failure or timeout; the returned function gives up early.
 */
function capture(
  a: ArtifactSummary,
  onThumb: (blob: Blob) => void,
  done: () => void,
): () => void {
  let frame: HTMLIFrameElement | null = null;
  let bridge: ReturnType<typeof createBridge> | null = null;
  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    bridge?.dispose();
    frame?.remove();
    done();
  };
  const timer = setTimeout(finish, TIMEOUT_MS);
  // Not aborted when given up: a late reply is just ignored.
  api.get(R.contentUrl(a.id), ContentUrlSchema).then(
    (c) => {
      if (over) return;
      const url = safeContentUrl(c.url);
      if (!url) return finish();
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", BACKGROUND_SANDBOX);
      f.setAttribute("referrerpolicy", "no-referrer");
      f.setAttribute("aria-hidden", "true");
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
          if (!b.requestThumbnail()) finish();
        },
        onThumb: (blob) => {
          onThumb(blob);
          finish();
        },
      });
      frame = f;
      bridge = b;
      f.src = url;
      document.body.append(f);
    },
    (e) => {
      if (!over) console.debug("background thumbnail failed", e);
      finish();
    },
  );
  return finish;
}

/**
 * Captures missing thumbnails for `items` the caller may edit, one hidden frame at
 * a time, at most MAX_ATTEMPTS per session, only while the tab is visible.
 */
export function useBackgroundThumbnails(items: ArtifactSummary[]) {
  const qc = useQueryClient();
  const offer = useRef<(items: ArtifactSummary[]) => void>(() => {});

  useEffect(() => {
    let queue: ArtifactSummary[] = [];
    let cancel: (() => void) | null = null;
    let stopped = false;
    const pump = () => {
      if (
        stopped ||
        cancel ||
        attempts >= MAX_ATTEMPTS ||
        document.visibilityState !== "visible" ||
        saveData()
      )
        return;
      queue = queue.filter(eligible);
      const a = queue.shift();
      if (!a) return;
      attempts++;
      thumbAsked.add(a.id);
      cancel = capture(
        a,
        (blob) =>
          uploadThumbnail(a.id, blob, api.putBody, () =>
            invalidateThumbnail(qc, a.id),
          ),
        () => {
          cancel = null;
          pump();
        },
      );
    };
    offer.current = (items) => {
      queue = items.filter(eligible);
      pump();
    };
    document.addEventListener("visibilitychange", pump);
    return () => {
      stopped = true;
      offer.current = () => {};
      document.removeEventListener("visibilitychange", pump);
      cancel?.();
    };
  }, [qc]);

  useEffect(() => offer.current(items), [items]);
}
