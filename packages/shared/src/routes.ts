const A = "/api/v1/artifacts";
// "." and ".." segments (even percent-encoded) are collapsed by URL parsers, so they cannot be
// represented safely; refuse them rather than emit a URL that resolves elsewhere.
const seg = (s: string): string => {
  if (s === "." || s === "..")
    throw new RangeError(`Unsafe path segment: ${JSON.stringify(s)}`);
  return encodeURIComponent(s);
};

export const R = {
  /** GET -> Me */
  me: "/api/v1/me",
  /** GET (ListQuery) -> Page<ArtifactSummary>; POST PublishInput (JSON) -> PublishResult. Inline content (content, text files and base64 together) is limited to LIMITS.inlineBytes (128 KB): over it, or a body over twice that plus 64 KB, 413 too_large (INLINE_TOO_LARGE_MESSAGE); larger files go through R.uploads then files: { path: { uploadId } }. Publishing to an uploaded/reserved id with no existing artifact requires title; the server returns 400 without it. */
  artifacts: A,
  /** GET -> ArtifactSummary; PATCH ArtifactPatch -> ArtifactSummary; DELETE soft-delete -> 204 */
  artifact: (id: string) => `${A}/${seg(id)}`,
  /** POST -> ArtifactSummary */
  restoreDeleted: (id: string) => `${A}/${seg(id)}/undelete`,
  /**
   * GET -> VersionInfo[]: newest first with version < `before` (all versions when omitted).
   * A page holds at most VERSIONS_PAGE_SIZE (20) and stops early once its manifests pass
   * ~1 MiB (always at least one), so pages may be shorter than 20: page on with
   * `before` = the last version; only an empty array means the end.
   * POST PublishInput (new version) -> PublishResult
   */
  versions: (id: string, before?: number) => {
    if (before !== undefined && !(Number.isInteger(before) && before >= 1))
      throw new RangeError(`before must be an integer >= 1: ${before}`);
    return `${A}/${seg(id)}/versions${before === undefined ? "" : `?before=${before}`}`;
  },
  /** GET raw file bytes (auth), for diff */
  versionFile: (id: string, v: number, path: string) =>
    `${A}/${seg(id)}/versions/${v}/files/${path.split("/").map(seg).join("/")}`,
  /** POST -> PublishResult */
  restoreVersion: (id: string, v: number) =>
    `${A}/${seg(id)}/versions/${v}/restore`,
  /** PUT text/plain (PDF extraction) -> 204 */
  versionText: (id: string, v: number) => `${A}/${seg(id)}/versions/${v}/text`,
  /** GET -> image/webp; PUT image/webp -> 204 */
  thumbnail: (id: string) => `${A}/${seg(id)}/thumbnail`,
  /** GET -> ContentUrl */
  contentUrl: (id: string, v?: number) =>
    `${A}/${seg(id)}/content-url${v !== undefined ? `?v=${v}` : ""}`,
  /** GET -> Share[]; PUT ShareInput -> Share */
  shares: (id: string) => `${A}/${seg(id)}/shares`,
  /** DELETE -> 204 */
  share: (id: string, email: string) => `${A}/${seg(id)}/shares/${seg(email)}`,
  /** POST UploadCreateInput -> UploadCreated */
  uploads: "/api/v1/uploads",
  /** PUT raw body (signed: ?sig=...&exp=...) -> 204 */
  upload: (uploadId: string) => `/api/v1/uploads/${seg(uploadId)}`,
  /**
   * GET ?q=&cursor=&limit= -> Page<SearchHit>
   *
   * Body text is indexed asynchronously after publish, restore and undelete
   * (C3), within ~10 s (LIMITS.indexDebounceMs; a burst of versions indexes
   * only the newest; longer while retrying). Until then a new or undeleted
   * artifact matches on title/description only, and a new version still
   * matches the previous version's body. Title/description changes (PATCH)
   * apply immediately. Only the first 64 KB (LIMITS.indexTextBytes) of a
   * document's entry file is indexed: text past that never matches.
   */
  search: "/api/v1/search",
  /** GET -> Member[]; POST MemberInvite -> Member */
  members: "/api/v1/members",
  /** PATCH MemberPatch -> Member; DELETE -> 204 */
  member: (id: string) => `/api/v1/members/${seg(id)}`,
  /** GET -> Token[]; POST TokenCreateInput -> TokenCreated */
  tokens: "/api/v1/tokens",
  /** DELETE -> 204 */
  token: (id: string) => `/api/v1/tokens/${seg(id)}`,
  /** GET -> OAuthClient[] */
  oauthClients: "/api/v1/oauth-clients",
  /** DELETE -> 204 */
  oauthClient: (grantId: string) => `/api/v1/oauth-clients/${seg(grantId)}`,
  /** GET -> Settings; PATCH SettingsPatch -> Settings */
  settings: "/api/v1/settings",
  /**
   * GET -> Usage: today's (UTC) free-plan counts. Also `cpu_limit_hits`
   * (invocations ending exceededCpu or exceededResources; limit 0) and
   * `cpu_p99_ms` (p99 CPU time in ms; limit 10 on Free, 0 when not applicable),
   * both for this Worker's script, and `kv_writes` (OAUTH_KV write operations;
   * limit 1000). Each is omitted when unavailable.
   */
  usage: "/api/v1/usage",
  /** GET -> Page<DataDoc> */
  dataCollection: (id: string, col: string) =>
    `${A}/${seg(id)}/data/${seg(col)}`,
  /** POST DataQuery -> Page<DataDoc> */
  dataQuery: (id: string, col: string) =>
    `${A}/${seg(id)}/data/${seg(col)}/query`,
  /** GET -> DataDoc; PUT DataSetBody (raw JSON doc) -> DataDoc; PATCH DataPatchBody (merge) -> DataDoc; DELETE -> 204. A doc (after a merge too) is ≤ dataDocLimit(plan): 256 KB on Workers Free, 1 MB on Paid (env PLAN), counting the body's bytes as sent (whitespace included; a merge counts the merged doc serialized). Over it, 413 too_large with dataDocTooLargeMessage(plan), from Content-Length before the body is read when declared. */
  dataDoc: (id: string, col: string, doc: string) =>
    `${A}/${seg(id)}/data/${seg(col)}/${seg(doc)}`,
  /** GET Upgrade: websocket; frames are DataChange */
  dataSubscribe: (id: string, col: string) =>
    `${A}/${seg(id)}/data-subscribe?collection=${seg(col)}`,
  /** GET -> Page<StorageKey> */
  storage: (id: string) => `${A}/${seg(id)}/storage`,
  /** GET -> StorageEntry; PUT StorageSetBody { value } (strict; StorageSetBodySchema) -> StorageEntry; DELETE -> 204. `value` has the data-doc limit (dataDocLimit(plan), 413 too_large). */
  storageKey: (id: string, key: string) =>
    `${A}/${seg(id)}/storage/${seg(key)}`,
} as const;

export const AUTH = {
  login: "/auth/login",
  callback: "/auth/callback",
  logout: "/auth/logout",
  devLogin: "/auth/dev-login",
} as const;

export const MCP_PATH = "/mcp";

export const diffPath = (id: string, from: number, to: number) =>
  `/a/${seg(id)}/diff/${from}/${to}`;

export const PAGES = { noAccess: "/no-access", search: "/search" } as const;

export const viewerPath = (id: string, v?: number) =>
  v !== undefined ? `/a/${seg(id)}/v/${v}` : `/a/${seg(id)}`;
