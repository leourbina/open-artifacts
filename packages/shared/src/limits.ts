/** GET versions returns at most this many VersionInfo per request. */
export const VERSIONS_PAGE_SIZE = 20;

export const LIMITS = {
  fileBytes: 25 * 1024 * 1024,
  publishBytes: 100 * 1024 * 1024,
  inlineBytes: 2 * 1024 * 1024,
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
} as const;
