import { type ArtifactSummary, LIMITS, R } from "@oa/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { api } from "../api/client";
import { qk, useVersionInfo } from "../api/queries";

// Once per session, across remounts.
const thumbAsked = new Set<string>();
const textSent = new Set<string>();

/** Cuts to at most `max` UTF-8 bytes, never in the middle of a character or surrogate pair. */
export function truncateUtf8(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

export interface SideEffectDeps {
  artifact: ArtifactSummary;
  version: number;
  getInfo: () => { format: string; textIndexed: boolean } | undefined;
  requestThumbnail: () => boolean;
  put: (
    path: string,
    body: Blob | string,
    contentType: string,
  ) => Promise<void>;
  invalidate: (keys: "thumbnail" | "text") => void;
}

export function createSideEffects(d: SideEffectDeps) {
  const { artifact, version } = d;
  const id = artifact.id;
  const canEdit = artifact.access === "editor" || artifact.access === "owner";
  let pending: string | undefined;
  return {
    onHello() {
      const stale =
        artifact.thumbnailVersion == null ||
        artifact.thumbnailVersion < artifact.currentVersion;
      const key = `${id}:${artifact.currentVersion}`;
      if (
        !canEdit ||
        !stale ||
        version !== artifact.currentVersion ||
        thumbAsked.has(key)
      )
        return;
      if (d.requestThumbnail()) thumbAsked.add(key);
    },
    onThumb(blob: Blob) {
      if (!canEdit || blob.size > LIMITS.thumbnailBytes) return;
      if (version !== artifact.currentVersion) return;
      d.put(`${R.thumbnail(id)}?v=${version}`, blob, "image/webp").then(
        () => d.invalidate("thumbnail"),
        (e) => {
          // 409: the server already holds a newer thumbnail.
          if ((e as { status?: number } | null)?.status === 409)
            d.invalidate("thumbnail");
          else console.debug("thumbnail upload failed", e);
        },
      );
    },
    onPdfText(text: string) {
      pending = text;
      this.flushPending();
    },
    /** Sends the latest pending text once the version info needed to judge it is known. */
    flushPending() {
      const text = pending;
      const info = d.getInfo();
      if (text === undefined || !info) return;
      const key = `${id}:${version}`;
      if (
        !canEdit ||
        version !== artifact.currentVersion ||
        info.format !== "pdf" ||
        info.textIndexed ||
        textSent.has(key)
      )
        return;
      pending = undefined;
      textSent.add(key);
      d.put(
        R.versionText(id, version),
        truncateUtf8(text, LIMITS.extractedTextBytes),
        "text/plain",
      ).then(
        () => d.invalidate("text"),
        (e) => console.debug("pdf text upload failed", e),
      );
    },
  };
}

/** Thumbnail capture and PDF text indexing, driven by the bridge. */
export function useArtifactSideEffects(
  artifact: ArtifactSummary,
  version: number,
  requestThumbnail: () => boolean,
) {
  const qc = useQueryClient();
  const info = useVersionInfo(artifact.id, version).data ?? undefined;
  const latest = useRef({ info, requestThumbnail });
  latest.current = { info, requestThumbnail };
  const id = artifact.id;
  // Rebuilt only when the artifact's identity, version or rights change.
  const key = `${id}:${version}:${artifact.currentVersion}:${artifact.access}:${artifact.thumbnailVersion}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by `key`
  const fx = useMemo(
    () =>
      createSideEffects({
        artifact,
        version,
        getInfo: () => latest.current.info,
        requestThumbnail: () => latest.current.requestThumbnail(),
        put: (path, body, ct) => api.putBody(path, body, ct),
        invalidate: (what) => {
          if (what === "thumbnail") {
            void qc.invalidateQueries({ queryKey: qk.artifact(id) });
            void qc.invalidateQueries({ queryKey: ["artifacts"] });
          } else void qc.invalidateQueries({ queryKey: qk.versions(id) });
        },
      }),
    [key, qc],
  );
  // Text may arrive before the version info does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when info lands
  useEffect(() => fx.flushPending(), [fx, info]);
  return fx;
}
