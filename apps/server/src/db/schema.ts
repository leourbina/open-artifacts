import {
  FORMATS,
  RoleSchema,
  ShareRoleSchema,
  VisibilitySchema,
} from "@oa/shared";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const inList = (col: string, values: readonly string[]) =>
  sql.raw(`"${col}" in (${values.map((v) => `'${v}'`).join(", ")})`);

// EMAIL RULE: all email writes and lookups go through normEmail() (./email.ts),
// because SQLite COLLATE NOCASE only folds ASCII.
//
// FTS RULE (for B8): artifact_search rows use rowid = artifacts.rowid (the implicit
// integer rowid). Insert with that rowid and delete with
// `DELETE FROM artifact_search WHERE rowid = (SELECT rowid FROM artifacts WHERE id = ?)`;
// deleting by the UNINDEXED artifact_id column is a full scan.
//
// NOTE: users.email and shares.email need `COLLATE NOCASE`, which Drizzle cannot
// express; migrations/0001_init.sql is hand-edited for those two columns.
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    /** IdP name (or the sign-in default); refreshed on every sign-in. */
    name: text("name").notNull(),
    /** The name the user chose (PATCH /me); never touched by sign-in. */
    displayName: text("display_name"),
    role: text("role").notNull(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at"),
    /** Bumped to end every session of the user (role change, link reset, P3 sync). */
    sessionEpoch: integer("session_epoch").notNull().default(0),
    /** MemberStatus (@oa/shared): active | suspended | removed. P3's sync sets it; sign-in refuses non-active. */
    status: text("status").notNull().default("active"),
  },
  () => [check("users_role_check", inList("role", RoleSchema.options))],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    description: text("description"),
    format: text("format").notNull(),
    visibility: text("visibility").notNull().default("private"),
    currentVersion: integer("current_version").notNull().default(0),
    capabilities: text("capabilities")
      .notNull()
      .default('{"db":false,"viewer":false,"storage":false}'),
    allowAnonymousWrites: integer("allow_anonymous_writes")
      .notNull()
      .default(0),
    hasThumbnail: integer("has_thumbnail").notNull().default(0),
    /** The version thumbs/{id}.webp depicts; null = unknown (pre-0005) or none. */
    thumbnailVersion: integer("thumbnail_version"),
    lastAgentName: text("last_agent_name"),
    lastAgentVersion: text("last_agent_version"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    /** Failed purge runs so far; each failure defers the next try (cron backoff). */
    purgeAttempts: integer("purge_attempts").notNull().default(0),
    /** Not retried by the purge cron before this time (ms); null = due. */
    purgeAfter: integer("purge_after"),
  },
  (t) => [
    // Partial indexes only (#248): every index entry is a billed D1 row write,
    // and each publish bumps updated_at. Live rows: the *_live pair. Deleted
    // rows: the owner's trash listing and the purge cron.
    index("artifacts_owner_deleted_idx")
      .on(t.ownerId, t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    index("artifacts_deleted_idx")
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    index("artifacts_visibility_updated_live_idx")
      .on(t.visibility, t.updatedAt)
      .where(sql`${t.deletedAt} is null`),
    index("artifacts_owner_updated_live_idx")
      .on(t.ownerId, t.updatedAt)
      .where(sql`${t.deletedAt} is null`),
    check(
      "artifacts_allow_anon_check",
      sql`${t.allowAnonymousWrites} in (0, 1)`,
    ),
    check("artifacts_thumbnail_check", sql`${t.hasThumbnail} in (0, 1)`),
    check(
      "artifacts_capabilities_json_check",
      sql`json_valid(${t.capabilities})`,
    ),
    check("artifacts_format_check", inList("format", FORMATS)),
    check(
      "artifacts_visibility_check",
      inList("visibility", VisibilitySchema.options),
    ),
  ],
);

export const versions = sqliteTable(
  "versions",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    entry: text("entry").notNull(),
    // JSON: [{path,key,size,contentType}]
    manifest: text("manifest").notNull().default("[]"),
    language: text("language"),
    message: text("message"),
    agentName: text("agent_name"),
    agentVersion: text("agent_version"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    textIndexed: integer("text_indexed").notNull().default(0),
    // NULL only on rows written before 0002 (or by pre-0002 code): readers fall
    // back to artifacts.format.
    format: text("format"),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.version] }),
    check("versions_manifest_json_check", sql`json_valid(${t.manifest})`),
    check("versions_format_check", inList("format", FORMATS)),
  ],
);

export const shares = sqliteTable(
  "shares",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.email] }),
    index("shares_email_idx").on(t.email),
    check("shares_role_check", inList("role", ShareRoleSchema.options)),
  ],
);

export const tokens = sqliteTable("tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  label: text("label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
});

export const uploads = sqliteTable("uploads", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  r2Key: text("r2_key").notNull(),
  size: integer("size").notNull(),
  contentType: text("content_type").notNull(),
  path: text("path").notNull(),
  createdAt: integer("created_at").notNull(),
  consumed: integer("consumed").notNull().default(0),
  // set once the signed PUT stored exactly `size` bytes
  receivedAt: integer("received_at"),
});

// ids handed out by create_upload before the first publish
export const reservedArtifacts = sqliteTable("reserved_artifacts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Small D1 counters and markers (e.g. daily OAuth client registrations), kept
// out of KV because KV writes are the scarcer Free-plan quota.
export const counters = sqliteTable("counters", {
  key: text("key").primaryKey(),
  n: integer("n").notNull(),
  day: text("day").notNull(),
});

// The only link between a person and an IdP account (P2). For Google,
// subject = the OIDC `sub` = the Directory API user id, so P3's sync and
// sign-in meet on one row. Access sign-in stays email-keyed (no rows).
export const identities = sqliteTable(
  "identities",
  {
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    /** The verified tenant (Google hd) at link time. */
    tenant: text("tenant").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    uniqueIndex("identities_user_provider").on(t.userId, t.provider),
  ],
);

// Emailed one-time sign-in codes (P2), one row per request so a stranger's
// request can't replace a victim's pending code. No plaintext: email_key and
// code_hash are HMACs under deriveKey("oa:login-codes").
export const loginCodes = sqliteTable(
  "login_codes",
  {
    emailKey: text("email_key").notNull(),
    requestId: text("request_id").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.emailKey, t.requestId] })],
);

// Signed nightly trigger (/__oa/nightly) nonces, keyed by the UTC day of the
// signed ts so a replay maps to the same row. The nightly job drops rows older
// than 2 days. WITHOUT ROWID is hand-edited into the migration.
export const nightlyRuns = sqliteTable(
  "nightly_runs",
  {
    day: text("day").notNull(),
    nonce: text("nonce").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.nonce] })],
);
