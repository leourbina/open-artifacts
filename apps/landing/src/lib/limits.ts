import { LIMITS } from "@oa/shared";

// Docs quote limits as {LIMIT_*} placeholders, filled from @oa/shared's
// LIMITS at build time, so a changed limit can't leave a stale number.

/** Bytes as the docs write them: "2 MB", "512 KB", "1.5 MB". */
export function formatBytes(n: number): string {
  const [unit, size] = n >= 1024 * 1024 ? ["MB", 1024 * 1024] : ["KB", 1024];
  return `${Number((n / size).toFixed(1))} ${unit}`;
}

/** Seconds as the docs write them: "10 minutes", "1 hour", "45 seconds". */
export function formatSeconds(s: number): string {
  const [n, unit] =
    s % 3600 === 0
      ? [s / 3600, "hour"]
      : s % 60 === 0
        ? [s / 60, "minute"]
        : [s, "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export const LIMIT_PLACEHOLDERS: Record<string, string> = {
  "{LIMIT_INLINE}": formatBytes(LIMITS.inlineBytes),
  "{LIMIT_FILE}": formatBytes(LIMITS.fileBytes),
  "{LIMIT_PUBLISH}": formatBytes(LIMITS.publishBytes),
  "{LIMIT_DOC}": formatBytes(LIMITS.docBytes),
  "{LIMIT_ARTIFACT_DATA}": formatBytes(LIMITS.artifactDataBytes),
  "{LIMIT_VIEWER_WRITES}": `${LIMITS.viewerWritesPerMin} per minute`,
  "{LIMIT_ANON_WRITES}": `${LIMITS.anonWritesPerMinPerIp} per minute`,
  "{LIMIT_SIGNED_URL_TTL}": formatSeconds(LIMITS.signedUrlTtlSec),
  "{LIMIT_SOFT_DELETE}": plural(LIMITS.softDeleteDays, "day"),
  "{LIMIT_UPLOAD_URL_TTL}": formatSeconds(LIMITS.uploadUrlTtlSec),
  "{LIMIT_UPLOAD_TTL}": plural(LIMITS.uploadTtlHours, "hour"),
  "{LIMIT_INDEX_LAG}": formatSeconds(LIMITS.indexDebounceMs / 1000),
  "{LIMIT_INDEX_TEXT}": formatBytes(LIMITS.indexTextBytes),
};
