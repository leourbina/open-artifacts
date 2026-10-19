/** GET versions returns at most this many VersionInfo per request. */
export const VERSIONS_PAGE_SIZE = 20;

export const LIMITS = {
  fileBytes: 25 * 1024 * 1024,
  publishBytes: 100 * 1024 * 1024,
  /**
   * Inline (JSON) publish payload; larger files go through create_upload (C3).
   * 128 KB bounds the request's JSON.parse (escape-heavy text doubles the
   * body) to the 10 ms CPU budget; see docs/ops/cpu-budget.md.
   */
  inlineBytes: 128 * 1024,
  docBytes: 1024 * 1024,
  artifactDataBytes: 50 * 1024 * 1024,
  viewerWritesPerMin: 100,
  anonWritesPerMinPerIp: 30,
  pathMaxChars: 512,
  filesPerVersion: 1000,
  searchBodyChars: 200_000,
  signedUrlTtlSec: 600,
  softDeleteDays: 30,
  uploadTtlHours: 24,
  uploadUrlTtlSec: 3600,
  thumbnailBytes: 200 * 1024,
  extractedTextBytes: 1024 * 1024,
  /** Search indexes only the first this-many bytes of an artifact's entry file. */
  indexTextBytes: 64 * 1024,
  /** Body text is indexed this long after a publish/restore/undelete; bursts coalesce. */
  indexDebounceMs: 10_000,
} as const;

/** The 413 too_large message for inline publish content over LIMITS.inlineBytes (REST and MCP). */
export const INLINE_TOO_LARGE_MESSAGE = `Inline content is limited to ${LIMITS.inlineBytes / 1024} KB per publish. For larger files: create_upload({ path, size, contentType }), PUT the bytes to the returned url, then publish_artifact({ id: artifactId, title, files: { "<path>": { uploadId } } }).`;
