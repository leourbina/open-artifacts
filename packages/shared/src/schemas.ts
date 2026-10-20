import { z } from "zod";
import { FORMATS } from "./formats.js";
import { isId } from "./ids.js";
import { INLINE_TOO_LARGE_MESSAGE, LIMITS } from "./limits.js";
import { findCaseCollision, normalizePath } from "./paths.js";
import { utf8Exceeds } from "./utf8.js";

export const VisibilitySchema = z.enum(["private", "team", "public"]);
export type Visibility = z.infer<typeof VisibilitySchema>;
export const RoleSchema = z.enum(["owner", "admin", "member", "guest"]);
export type Role = z.infer<typeof RoleSchema>;
export const ShareRoleSchema = z.enum(["viewer", "editor"]);
export type ShareRole = z.infer<typeof ShareRoleSchema>;
export const AccessLevelSchema = z.enum(["owner", "editor", "viewer"]);
export type AccessLevel = z.infer<typeof AccessLevelSchema>;
export const IdSchema = z.string().refine(isId, "invalid id");

export const FormatSchema = z.enum(FORMATS);

export const CapabilitiesSchema = z.object({
  db: z.boolean().default(false),
  viewer: z.boolean().default(false),
  storage: z.boolean().default(false),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const CapabilitiesPatchSchema = z.strictObject({
  db: z.boolean().optional(),
  viewer: z.boolean().optional(),
  storage: z.boolean().optional(),
});
export type CapabilitiesPatch = z.infer<typeof CapabilitiesPatchSchema>;

/** `email` is null for anonymous viewers (no session, no Bearer) of public artifacts. */
export const UserRefSchema = z.object({
  id: z.string(),
  email: z.string().email().nullable(),
  name: z.string().nullable(),
});
export type UserRef = z.infer<typeof UserRefSchema>;

export const AgentRefSchema = z.object({
  name: z.string(),
  version: z.string().nullable(),
});
export type AgentRef = z.infer<typeof AgentRefSchema>;

export const FileEntrySchema = z.object({
  path: z.string(),
  size: z.number().int(),
  contentType: z.string(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const InlineFileSchema = z.union([
  z.string(),
  z.object({ base64: z.string() }),
  z.object({ uploadId: z.string() }),
]);
export type InlineFile = z.infer<typeof InlineFileSchema>;

const PublishShape = z.strictObject({
  id: z.string().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  format: FormatSchema.optional(),
  content: z.string().optional(),
  files: z.record(z.string(), InlineFileSchema).optional(),
  entry: z.string().optional(),
  language: z.string().optional(),
  message: z.string().max(500).optional(),
  visibility: VisibilitySchema.optional(),
  capabilities: CapabilitiesPatchSchema.optional(),
  allowAnonymousWrites: z.boolean().optional(),
});

const refinePublish =
  (inlineCheck: boolean) =>
  (v: z.infer<typeof PublishShape>, ctx: z.RefinementCtx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    const hasContent = v.content !== undefined;
    const hasFiles = v.files !== undefined;
    if (hasContent === hasFiles) {
      issue("Provide exactly one of content or files", [
        hasContent ? "files" : "content",
      ]);
    }
    if (v.id === undefined && v.title === undefined) {
      issue("title is required when id is absent", ["title"]);
    }
    if (v.id !== undefined && !isId(v.id))
      issue("id is not a valid artifact id", ["id"]);
    if (hasContent && v.format === undefined && v.entry === undefined) {
      issue("content requires format or entry", ["format"]);
    }
    if (
      inlineCheck &&
      v.content !== undefined &&
      utf8Exceeds(v.content, LIMITS.inlineBytes)
    ) {
      issue(INLINE_TOO_LARGE_MESSAGE, ["content"]);
    }
    const normalized = new Map<string, string>();
    if (v.files !== undefined) {
      const keys = Object.keys(v.files);
      if (keys.length === 0) issue("files must not be empty", ["files"]);
      if (keys.length > LIMITS.filesPerVersion) {
        issue(`files exceeds ${LIMITS.filesPerVersion} entries`, ["files"]);
      }
      for (const key of keys) {
        const r = normalizePath(key);
        if (!r.ok)
          issue(`Invalid file path "${key}": ${r.error}`, ["files", key]);
        else {
          const prev = normalized.get(r.path);
          if (prev !== undefined) {
            issue(
              `Duplicate file path: "${prev}" and "${key}" both normalize to "${r.path}"`,
              ["files", key],
            );
          } else normalized.set(r.path, key);
        }
      }
      const pair = findCaseCollision([...normalized.keys()]);
      if (pair)
        issue(`Case-colliding file paths: "${pair[0]}" and "${pair[1]}"`, [
          "files",
        ]);
    }
    if (v.entry !== undefined) {
      const r = normalizePath(v.entry);
      if (!r.ok) issue(`Invalid entry "${v.entry}": ${r.error}`, ["entry"]);
      else if (v.files !== undefined && !normalized.has(r.path)) {
        issue(`entry "${v.entry}" is not a key of files`, ["entry"]);
      }
    }
  };

export const PublishInputSchema = PublishShape.superRefine(refinePublish(true));
/**
 * PublishInputSchema without the inline-size check, for the MCP tool: the SDK
 * turns schema failures into InvalidParams, so oversize content is left to
 * the server's planFiles (413 too_large, INLINE_TOO_LARGE_MESSAGE).
 */
export const PublishToolInputSchema = PublishShape.superRefine(
  refinePublish(false),
);
export type PublishInput = z.infer<typeof PublishInputSchema>;

export const PublishResultSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  url: z.string().url(),
});
export type PublishResult = z.infer<typeof PublishResultSchema>;

export const ArtifactSummarySchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  format: FormatSchema,
  visibility: VisibilitySchema,
  owner: UserRefSchema,
  currentVersion: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  lastAgent: AgentRefSchema.nullable(),
  thumbnailUrl: z.string().nullable(),
  /**
   * The version the thumbnail depicts (server capture or client upload);
   * null without a thumbnail or for one stored before versions were tracked.
   * thumbnailUrl carries it as `?v=` so a new thumbnail busts caches.
   */
  thumbnailVersion: z.number().int().positive().nullable(),
  access: AccessLevelSchema,
  capabilities: CapabilitiesSchema,
  allowAnonymousWrites: z.boolean(),
});
export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;

export const VersionInfoSchema = z.object({
  version: z.number().int(),
  message: z.string().nullable(),
  agent: AgentRefSchema.nullable(),
  createdBy: UserRefSchema,
  createdAt: z.string(),
  entry: z.string(),
  files: z.array(FileEntrySchema),
  language: z.string().nullable(),
  textIndexed: z.boolean(),
  /** This version's format (old versions keep theirs after a later publish). */
  format: FormatSchema,
});
export type VersionInfo = z.infer<typeof VersionInfoSchema>;

export const ListQuerySchema = z.object({
  scope: z.enum(["mine", "shared", "team", "all"]).default("all"),
  format: FormatSchema.optional(),
  visibility: VisibilitySchema.optional(),
  owner: z.string().optional(),
  agent: z.string().optional(),
  q: z.string().optional(),
  updatedSince: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  includeDeleted: z.union([z.boolean(), z.stringbool()]).default(false),
});
export type ListQuery = z.infer<typeof ListQuerySchema>;
export type ListQueryInput = z.input<typeof ListQuerySchema>;

export type Page<T> = { items: T[]; nextCursor: string | null };
export const PageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const SearchHitSchema = ArtifactSummarySchema.extend({
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const ShareSchema = z.object({
  email: z.string().email(),
  role: ShareRoleSchema,
  createdAt: z.string(),
});
export type Share = z.infer<typeof ShareSchema>;

/** PUT shares response. */
export const ShareResultSchema = ShareSchema.extend({
  /** True if a notification email went to a non-member (best effort). */
  emailed: z.boolean(),
});
export type ShareResult = z.infer<typeof ShareResultSchema>;

export const ArtifactPatchSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000),
    visibility: VisibilitySchema,
    capabilities: CapabilitiesPatchSchema,
    allowAnonymousWrites: z.boolean(),
  })
  .partial();
export type ArtifactPatch = z.infer<typeof ArtifactPatchSchema>;

export const MemberSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: RoleSchema,
  lastSeenAt: z.string().nullable(),
});
export type Member = z.infer<typeof MemberSchema>;

export const MemberRoleInputSchema = RoleSchema.exclude(["owner", "guest"]);

export const MemberInviteSchema = z.strictObject({
  email: z.string().email(),
  role: MemberRoleInputSchema,
});
export type MemberInvite = z.infer<typeof MemberInviteSchema>;

/** POST members (invite) response. */
export const MemberInviteResultSchema = MemberSchema.extend({
  /** True if an invite email was sent (best effort). */
  emailed: z.boolean(),
});
export type MemberInviteResult = z.infer<typeof MemberInviteResultSchema>;

export const MemberPatchSchema = z.strictObject({
  role: MemberRoleInputSchema,
});
export type MemberPatch = z.infer<typeof MemberPatchSchema>;

export const ShareInputSchema = z.strictObject({
  email: z.string().email(),
  role: ShareRoleSchema,
});
export type ShareInput = z.infer<typeof ShareInputSchema>;

export const TokenCreateInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
});
export type TokenCreateInput = z.infer<typeof TokenCreateInputSchema>;

export const StorageEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.string(),
});
export type StorageEntry = z.infer<typeof StorageEntrySchema>;

/** PUT body for storageKey. */
export const StorageSetBodySchema = z.strictObject({ value: z.unknown() });
export type StorageSetBody = z.infer<typeof StorageSetBodySchema>;

export const StorageKeySchema = z.object({
  key: z.string(),
  updatedAt: z.string(),
});
export type StorageKey = z.infer<typeof StorageKeySchema>;

const NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Collection name or document id. The regex excludes "." so "." and ".." cannot occur. */
export const DataNameSchema = z.string().regex(NAME_RE);
export type DataName = z.infer<typeof DataNameSchema>;
/** Storage key name (same rules as DataNameSchema). */
export const StorageKeyNameSchema = z.string().regex(NAME_RE);

/** Markers around matched terms in SearchHit.snippet. */
export const SNIPPET_MARK = { open: "\u0002", close: "\u0003" } as const;

export const ThemeSchema = z.enum(["light", "dark"]);
export type Theme = z.infer<typeof ThemeSchema>;

/** Latest stable release vs this instance (daily server check; owner and admins only). */
export const InstanceUpdateSchema = z.object({
  /** Latest stable release, X.Y.Z. */
  latestVersion: z.string(),
  /** This instance's version (/healthz `version`). */
  current: z.string(),
  /** A -dev or other non-release build: no comparison, updateAvailable is false. */
  custom: z.boolean(),
  updateAvailable: z.boolean(),
  /** Some release in (current, latestVersion] has "BREAKING CHANGE" in its
   * notes; false when none or up to date; null when unknown (rate-limited
   * fallback check, a range older than the last 100 releases, or custom). */
  breaking: z.boolean().nullable(),
  /** The latest release's notes on GitHub. */
  notesUrl: z.string(),
  /** When the last good check ran (ISO). */
  checkedAt: z.string(),
});
export type InstanceUpdate = z.infer<typeof InstanceUpdateSchema>;

export const MeSchema = z.object({
  /** `user.name` is the effective name: displayName, else a real IdP name, else the email. */
  user: MemberSchema,
  instance: z.object({
    name: z.string(),
    defaultVisibility: z.enum(["private", "team"]),
    appUrl: z.string(),
    mcpUrl: z.string(),
    /** Server can send invite/share emails; the result's `emailed` reports each send. */
    emailEnabled: z.boolean(),
    /** The instance's Workers plan (env PLAN), as /healthz reports it. */
    plan: z.enum(["free", "paid"]),
    /** Null for members and guests, and before the first good check. Optional: older servers omit it. */
    update: InstanceUpdateSchema.nullable().optional(),
  }),
  /** The name the user chose (PATCH R.me), or null. */
  displayName: z.string().nullable(),
  /** The IdP's name for the user when it is a real name (not the email's local part), else null. */
  suggestedName: z.string().nullable(),
  /** No chosen name and no usable IdP name: ask the user for one. */
  needsDisplayName: z.boolean(),
});
export type Me = z.infer<typeof MeSchema>;

/** C0/C1 controls (incl. CR/LF), bidi controls and zero-width characters. */
const isUnsafeNameChar = (cp: number) =>
  cp <= 0x1f ||
  (cp >= 0x7f && cp <= 0x9f) ||
  cp === 0x061c ||
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2060 && cp <= 0x2069) ||
  cp === 0xfeff;

/** A user-chosen display name: trimmed, 1–80 characters, no control/bidi/zero-width characters. */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1, "Name must not be blank")
  .refine((s) => [...s].length <= 80, "Name must be at most 80 characters")
  .refine(
    (s) => ![...s].some((ch) => isUnsafeNameChar(ch.codePointAt(0) ?? 0)),
    "Name contains invalid characters",
  );

export const MePatchSchema = z.strictObject({ displayName: DisplayNameSchema });
export type MePatch = z.infer<typeof MePatchSchema>;

export const TokenSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type Token = z.infer<typeof TokenSchema>;

export const TokenCreatedSchema = TokenSchema.extend({ token: z.string() });
export type TokenCreated = z.infer<typeof TokenCreatedSchema>;

export const OAuthClientSchema = z.object({
  grantId: z.string(),
  clientName: z.string(),
  createdAt: z.string(),
});
export type OAuthClient = z.infer<typeof OAuthClientSchema>;

export const SettingsSchema = z.object({
  name: z.string().min(1).max(80),
  defaultVisibility: z.enum(["private", "team"]),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsPatchSchema = SettingsSchema.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const UploadCreateInputSchema = z.strictObject({
  artifactId: IdSchema.optional(),
  path: z.string(),
  size: z.number().int().positive(),
  contentType: z.string().optional(),
});
export type UploadCreateInput = z.infer<typeof UploadCreateInputSchema>;

export const UploadCreatedSchema = z.object({
  uploadId: z.string(),
  artifactId: z.string(),
  url: z.string().url(),
  expiresAt: z.string(),
});
export type UploadCreated = z.infer<typeof UploadCreatedSchema>;

export const ContentUrlSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().nullable(),
});
export type ContentUrl = z.infer<typeof ContentUrlSchema>;

export const DataDocSchema = z.object({
  id: z.string(),
  data: z.unknown(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
export type DataDoc = z.infer<typeof DataDocSchema>;

/** GET R.dataCount response. */
export const DataCountSchema = z.object({ count: z.number().int() });
export type DataCount = z.infer<typeof DataCountSchema>;

const DATA_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isDataKey = (k: string) => DATA_KEY_RE.test(k) && !FORBIDDEN_KEYS.has(k);
const DataKeySchema = z.string().refine(isDataKey, "invalid key");
const WhereValue = z.union([
  z.string().max(1024),
  z.number(),
  z.boolean(),
  z.null(),
]);

// Validates own keys on the raw object so a JSON.parse'd "__proto__" is rejected, not dropped.
const WhereSchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      ctx.addIssue({ code: "custom", message: "where must be an object" });
      return;
    }
    const keys = Reflect.ownKeys(raw);
    if (keys.length > 32)
      ctx.addIssue({ code: "custom", message: "where has more than 32 keys" });
    for (const k of keys) {
      if (typeof k !== "string" || !isDataKey(k)) {
        ctx.addIssue({
          code: "custom",
          message: `invalid where key ${String(k)}`,
          path: [String(k)],
        });
      }
    }
  })
  .pipe(z.record(DataKeySchema, WhereValue));

export const DataSetBodySchema = z.unknown();
export type DataSetBody = z.infer<typeof DataSetBodySchema>;

export const DataPatchBodySchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      ctx.addIssue({ code: "custom", message: "patch must be an object" });
      return;
    }
    for (const k of Reflect.ownKeys(raw)) {
      if (typeof k !== "string" || !isDataKey(k)) {
        ctx.addIssue({
          code: "custom",
          message: `invalid patch key ${String(k)}`,
          path: [String(k)],
        });
      }
    }
  })
  .pipe(z.record(DataKeySchema, z.unknown()));
export type DataPatchBody = z.infer<typeof DataPatchBodySchema>;

/** Own string keys of a plain object, or null (JSON.parse'd "__proto__" stays an own key). */
const ownObjectKeys = (raw: unknown): string[] | null =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (Reflect.ownKeys(raw).filter((k) => typeof k === "string") as string[])
    : null;

/**
 * PUT R.dataReset body: `{ collections: { [collection]: { [docId]: data } } }`,
 * the artifact's whole data snapshot. Names follow DataNameSchema; each doc is
 * a DataSetBody (any JSON, ≤ dataDocLimit(plan) serialized, checked by the
 * server). At most LIMITS.dataResetCollections collections and `maxDocs`
 * docs (dataResetDocLimit(plan)). Keys are checked on the raw object, so the parsed
 * value is the input itself (z.record would silently drop a "__proto__" key):
 * iterate it with Object.entries, never copy it by assignment.
 */
export const dataResetBodySchema = (maxDocs: number) =>
  z
    .unknown()
    .superRefine((raw, ctx) => {
      if (ownObjectKeys(raw)?.join() !== "collections") {
        ctx.addIssue({
          code: "custom",
          message: "body must be { collections }",
        });
        return;
      }
      const cols = (raw as { collections: unknown }).collections;
      const names = ownObjectKeys(cols);
      if (!names) {
        ctx.addIssue({
          code: "custom",
          message: "collections must be an object",
          path: ["collections"],
        });
        return;
      }
      if (names.length > LIMITS.dataResetCollections)
        ctx.addIssue({
          code: "custom",
          message: `more than ${LIMITS.dataResetCollections} collections`,
          path: ["collections"],
        });
      let docs = 0;
      for (const name of names) {
        const path = ["collections", name];
        if (!DataNameSchema.safeParse(name).success)
          ctx.addIssue({ code: "custom", message: "invalid collection", path });
        const ids = ownObjectKeys((cols as Record<string, unknown>)[name]);
        if (!ids) {
          ctx.addIssue({
            code: "custom",
            message: "collection must be an object",
            path,
          });
          continue;
        }
        docs += ids.length;
        for (const id of ids)
          if (!DataNameSchema.safeParse(id).success)
            ctx.addIssue({
              code: "custom",
              message: "invalid document id",
              path: [...path, id],
            });
      }
      if (docs > maxDocs)
        ctx.addIssue({
          code: "custom",
          message: `more than ${maxDocs} documents`,
          path: ["collections"],
        });
    })
    .transform(
      (raw) =>
        raw as {
          collections: Record<string, Record<string, DataSetBody>>;
        },
    );
/** DataResetBody at the largest (Paid) doc count; the server applies its plan's. */
export const DataResetBodySchema = dataResetBodySchema(
  LIMITS.dataResetDocsPaid,
);
export type DataResetBody = z.infer<typeof DataResetBodySchema>;

/** PUT R.dataReset response: what the artifact now holds. */
export const DataResetResultSchema = z.object({
  collections: z.number().int(),
  docs: z.number().int(),
  updatedAt: z.string(),
});
export type DataResetResult = z.infer<typeof DataResetResultSchema>;

export const DataChangeSchema = z.object({
  type: z.literal("db.change"),
  collection: z.string(),
  docs: z.array(DataDocSchema),
  deleted: z.array(z.string()),
});
export type DataChange = z.infer<typeof DataChangeSchema>;

export const DataQuerySchema = z.strictObject({
  where: WhereSchema.optional(),
  orderBy: DataKeySchema.optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});
export type DataQuery = z.infer<typeof DataQuerySchema>;
export type DataQueryInput = z.input<typeof DataQuerySchema>;

export const UsageSchema = z.object({
  available: z.boolean(),
  /** The instance's Workers plan (env PLAN); every metric's `limit` follows it. */
  plan: z.enum(["free", "paid"]),
  date: z.string(),
  metrics: z.array(
    z.object({
      key: z.enum([
        "requests",
        "d1_reads",
        "d1_writes",
        "do_requests",
        "cpu_limit_hits",
        "cpu_p99_ms",
        "kv_writes",
      ]),
      used: z.number(),
      limit: z.number(),
    }),
  ),
});
export type Usage = z.infer<typeof UsageSchema>;

// ---- MCP tool inputs/results ----

export const GetArtifactInputSchema = z.strictObject({
  id: IdSchema,
  version: z.number().int().min(1).optional(),
  path: z.string().optional(),
  includeContent: z.boolean().default(true),
});
export type GetArtifactInput = z.infer<typeof GetArtifactInputSchema>;
export type GetArtifactInputInput = z.input<typeof GetArtifactInputSchema>;

export const SearchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(500),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
export type SearchQueryInput = z.input<typeof SearchQuerySchema>;

export const IdInputSchema = z.strictObject({ id: IdSchema });
export type IdInput = z.infer<typeof IdInputSchema>;

export const RestoreVersionInputSchema = z.strictObject({
  id: IdSchema,
  version: z.number().int().min(1),
});
export type RestoreVersionInput = z.infer<typeof RestoreVersionInputSchema>;

export const ShareArtifactInputSchema = ShareInputSchema.extend({
  id: IdSchema,
});
export type ShareArtifactInput = z.infer<typeof ShareArtifactInputSchema>;

export const UnshareInputSchema = z.strictObject({
  id: IdSchema,
  email: z.string().email(),
});
export type UnshareInput = z.infer<typeof UnshareInputSchema>;

export const SetVisibilityInputSchema = z.strictObject({
  id: IdSchema,
  visibility: VisibilitySchema,
});
export type SetVisibilityInput = z.infer<typeof SetVisibilityInputSchema>;

const dataTarget = { id: IdSchema, collection: DataNameSchema };

export const ArtifactDataGetInputSchema = z.strictObject({
  ...dataTarget,
  docId: DataNameSchema,
});
export type ArtifactDataGetInput = z.infer<typeof ArtifactDataGetInputSchema>;
export const ArtifactDataListInputSchema = z.strictObject({
  ...dataTarget,
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type ArtifactDataListInput = z.infer<typeof ArtifactDataListInputSchema>;
export const ArtifactDataQueryInputSchema = z.strictObject({
  ...dataTarget,
  query: DataQuerySchema,
});
export type ArtifactDataQueryInput = z.infer<
  typeof ArtifactDataQueryInputSchema
>;
export const ArtifactDataSetInputSchema = z.strictObject({
  ...dataTarget,
  docId: DataNameSchema,
  data: DataSetBodySchema,
});
export type ArtifactDataSetInput = z.infer<typeof ArtifactDataSetInputSchema>;
export const ArtifactDataUpdateInputSchema = z.strictObject({
  ...dataTarget,
  docId: DataNameSchema,
  patch: DataPatchBodySchema,
});
export type ArtifactDataUpdateInput = z.infer<
  typeof ArtifactDataUpdateInputSchema
>;
export const ArtifactDataDeleteInputSchema = z.strictObject({
  ...dataTarget,
  docId: DataNameSchema,
});
export type ArtifactDataDeleteInput = z.infer<
  typeof ArtifactDataDeleteInputSchema
>;

export const GetArtifactResultSchema = z.object({
  artifact: ArtifactSummarySchema,
  version: VersionInfoSchema,
  content: z.string().optional(),
  downloadUrl: z.string().optional(),
});
export type GetArtifactResult = z.infer<typeof GetArtifactResultSchema>;

export const CreateUploadInputSchema = UploadCreateInputSchema;
export type CreateUploadInput = UploadCreateInput;
