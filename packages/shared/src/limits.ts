/** GET versions returns at most this many VersionInfo per request. */
export const VERSIONS_PAGE_SIZE = 20;

const KB = 1024;
const INLINE_BYTES = 128 * KB;
const DATA_DOC_FREE = 256 * KB;
const DATA_DOC_PAID = 1024 * KB;

export const LIMITS = {
  fileBytes: 25 * 1024 * 1024,
  publishBytes: 100 * 1024 * 1024,
  /**
   * Inline (JSON) publish payload; larger files go through create_upload (C3).
   * 128 KB bounds the request's JSON.parse (escape-heavy text doubles the
   * body) to the 10 ms CPU budget; see docs/ops/cpu-budget.md.
   */
  inlineBytes: INLINE_BYTES,
  /**
   * One data doc (or per-viewer storage value) on Workers Free: UTF-8 bytes
   * of the JSON as received (REST: the raw body, whitespace included) or
   * serialized (MCP and the runtime bridge: JSON.stringify of the value).
   * A write's JSON work must fit the 10 ms CPU budget. Per instance via
   * dataDocLimit(plan).
   */
  dataDocBytesFree: DATA_DOC_FREE,
  /** One data doc on Workers Paid (no 10 ms CPU cap); measured as dataDocBytesFree. */
  dataDocBytesPaid: DATA_DOC_PAID,
  /** @deprecated use dataDocLimit(plan). The Paid data-doc limit (1 MB). */
  docBytes: DATA_DOC_PAID,
  /**
   * /mcp request body cap on Workers Free, checked before any parse: the
   * largest inline publish with every byte JSON-escaped (2×), plus 64 KB.
   */
  mcpBodyBytesFree: 2 * INLINE_BYTES + 64 * KB,
  /** /mcp request body cap on Workers Paid: a Paid data doc plus 64 KB. */
  mcpBodyBytesPaid: DATA_DOC_PAID + 64 * KB,
  artifactDataBytes: 50 * 1024 * 1024,
  /**
   * PUT R.dataReset body on Workers Free (the whole snapshot, as sent). The
   * Worker only caps and forwards it; the DO parses and validates (no 10 ms cap there).
   */
  dataResetBytesFree: 1024 * KB,
  /** PUT R.dataReset body on Workers Paid. */
  dataResetBytesPaid: 8 * 1024 * KB,
  /**
   * Docs in one data reset snapshot (all collections together) on Workers
   * Free: the DO's replace costs ~6 ms CPU at 500 docs / 1 MB (test:cpu).
   */
  dataResetDocsFree: 500,
  /** Docs in one data reset snapshot on Workers Paid. */
  dataResetDocsPaid: 5000,
  /** Collections in one data reset snapshot. */
  dataResetCollections: 100,
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

/** The instance's Workers plan (env PLAN): "paid" (trimmed, any case), else "free" (unset or anything else). */
export type Plan = "free" | "paid";
export const planOf = (v: unknown): Plan =>
  typeof v === "string" && v.trim().toLowerCase() === "paid" ? "paid" : "free";

/** Max bytes of one data doc (or storage value) on `plan`. */
export const dataDocLimit = (plan: Plan): number =>
  plan === "paid" ? LIMITS.dataDocBytesPaid : LIMITS.dataDocBytesFree;

/** Max PUT R.dataReset body bytes on `plan`, checked before the body is read. */
export const dataResetLimit = (plan: Plan): number =>
  plan === "paid" ? LIMITS.dataResetBytesPaid : LIMITS.dataResetBytesFree;

/** Max docs in one data reset snapshot on `plan`. */
export const dataResetDocLimit = (plan: Plan): number =>
  plan === "paid" ? LIMITS.dataResetDocsPaid : LIMITS.dataResetDocsFree;

/** The 413 too_large message for a data reset body over dataResetLimit(plan). */
export const dataResetTooLargeMessage = (plan: Plan): string =>
  `A data reset snapshot is limited to ${dataResetLimit(plan) / 1024 / 1024} MB on this instance; Workers Paid allows ${LIMITS.dataResetBytesPaid / 1024 / 1024} MB.`;

/** Max /mcp request body bytes on `plan`, checked before any parse. */
export const mcpBodyLimit = (plan: Plan): number =>
  plan === "paid" ? LIMITS.mcpBodyBytesPaid : LIMITS.mcpBodyBytesFree;

/** The 413 too_large message for a data doc (or storage value) over dataDocLimit(plan). */
export const dataDocTooLargeMessage = (plan: Plan): string =>
  `Data docs are limited to ${dataDocLimit(plan) / 1024} KB on this instance; Workers Paid allows ${LIMITS.dataDocBytesPaid / 1024 / 1024} MB.`;

/**
 * The /mcp 413 message, for both ways to get there: a large file (use the
 * upload path) and a large data doc (the plan's limit; JSON-RPC escaping
 * inflates non-ASCII sent as \u, so UTF-8 or the REST data API fits more).
 */
export const mcpTooLargeMessage = (plan: Plan): string =>
  `Request body exceeds ${mcpBodyLimit(plan) / 1024} KB on this instance. Large files: create_upload({ path, size, contentType }), PUT the bytes to the returned url, then publish_artifact({ id: artifactId, title, files: { "<path>": { uploadId } } }). Data docs on this instance are limited to ${dataDocLimit(plan) / 1024} KB; clients that escape non-ASCII as \\u inflate the request, so send UTF-8 or use the REST data API. Workers Paid allows ${LIMITS.dataDocBytesPaid / 1024 / 1024} MB.`;

/**
 * Daily caps the usage page measures against, per plan (GET /usage `limit`).
 * 0 means no daily cap: Workers Paid bills monthly included amounts and
 * overage, which are not daily caps. cpu_p99_ms is per invocation, not daily:
 * Free 10 ms; Paid the default 30 s (the repo sets no `limits.cpu_ms`).
 * cpu_limit_hits is a count with no cap on either plan.
 * Sources: https://developers.cloudflare.com/workers/platform/pricing/ and
 * https://developers.cloudflare.com/workers/platform/limits/
 */
export const USAGE_LIMITS = {
  free: {
    requests: 100_000,
    d1_reads: 5_000_000,
    d1_writes: 100_000,
    do_requests: 100_000,
    cpu_limit_hits: 0,
    cpu_p99_ms: 10,
    kv_writes: 1_000,
  },
  paid: {
    requests: 0,
    d1_reads: 0,
    d1_writes: 0,
    do_requests: 0,
    cpu_limit_hits: 0,
    cpu_p99_ms: 30_000,
    kv_writes: 0,
  },
} as const satisfies Record<Plan, Record<string, number>>;

/** The usage `limit` of metric `key` on `plan` (0: no daily cap). */
export const usageLimit = (
  plan: Plan,
  key: keyof (typeof USAGE_LIMITS)["free"],
): number => USAGE_LIMITS[plan][key];
