import type { AccessLevel, ListQuery, Member } from "@oa/shared";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "../db/client.js";
import { normEmail } from "../db/email.js";
import { artifacts, shares } from "../db/schema.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import { TEAM_ROLES } from "./policy.js";

/** Roles that see `team` artifacts (defined in policy.ts). */
export { TEAM_ROLES };

export type Caller = { kind: "user"; user: Member } | { kind: "anonymous" };
export type ArtifactRow = typeof artifacts.$inferSelect;

// "manager" (hosted M1 contract) is never produced yet; P3 sets its semantics.
const RANK: Record<AccessLevel, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
  owner: 3,
};

export function caller(c: Context<AppEnv>): Caller {
  const user = c.var.user;
  return user ? { kind: "user", user } : { kind: "anonymous" };
}

/** The signed-in user, or 401. */
export function requireUser(c: Context<AppEnv>): Member {
  const user = c.var.user;
  if (!user) throw new ApiError("unauthorized", "Sign in required");
  return user;
}

const callerEmail = (u: Member) => normEmail(u.email);

/**
 * Spec §6.5 rev 2, in order: deleted → null (unless the creator and
 * `allowDeleted`, for undelete); creator → owner; share for the caller's email →
 * share.role; team + owner/admin/member → viewer; public → viewer; else null.
 * Admins get no implicit access to private artifacts.
 */
export async function accessLevel(
  env: Env,
  c: Caller,
  artifactId: string,
  opts: { allowDeleted?: boolean } = {},
): Promise<{ level: AccessLevel; artifact: ArtifactRow } | null> {
  const db = getDb(env);
  const user = c.kind === "user" ? c.user : null;
  const email = user ? callerEmail(user) : null;
  const rows = await db
    .select({ a: artifacts, shareRole: shares.role })
    .from(artifacts)
    .leftJoin(
      shares,
      and(
        eq(shares.artifactId, artifacts.id),
        // No email → never matches a share.
        email ? eq(shares.email, email) : sql`0`,
      ),
    )
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const a = row.a;
  const isCreator = user !== null && a.ownerId === user.id;
  if (a.deletedAt != null && !(isCreator && opts.allowDeleted)) return null;
  if (isCreator) return { level: "owner", artifact: a };
  if (row.shareRole === "viewer" || row.shareRole === "editor")
    return { level: row.shareRole, artifact: a };
  if (a.visibility === "team" && user && TEAM_ROLES.includes(user.role))
    return { level: "viewer", artifact: a };
  if (a.visibility === "public") return { level: "viewer", artifact: a };
  return null;
}

/**
 * Does `level` satisfy `min`? "owner" is exact: a space "manager" (hosted M1,
 * same rank) never passes an owner check, so single transfer and anything
 * else owner-only stays with the personal owner.
 */
export const meetsLevel = (level: AccessLevel, min: AccessLevel): boolean =>
  min === "owner" ? level === "owner" : RANK[level] >= RANK[min];

/** The artifact if the caller has at least `min`; otherwise 404 (never 403). */
export async function requireAccess(
  env: Env,
  c: Caller,
  artifactId: string,
  min: AccessLevel,
  opts: { allowDeleted?: boolean } = {},
): Promise<ArtifactRow> {
  const r = await accessLevel(env, c, artifactId, opts);
  if (!r || !meetsLevel(r.level, min))
    throw new ApiError("not_found", "Not found");
  return r.artifact;
}

/**
 * WHERE fragment over `artifacts` for list/search, consistent with accessLevel:
 * - mine: created by the caller.
 * - shared: a share for the caller's email, not created by the caller.
 * - team: visibility team or public, caller is owner/admin/member (never guests).
 * - all: the union.
 * Public artifacts reachable only by link are not listed to guests (spec: guests
 * see only what's shared). Anonymous → always false (list routes require a user).
 * Deleted rows are excluded, unless `includeDeleted`, and then only the caller's own.
 */
export function listFilterSql(
  c: Caller,
  scope: ListQuery["scope"],
  includeDeleted = false,
): SQL {
  if (c.kind !== "user") return sql`0`;
  const { user } = c;
  const email = callerEmail(user);
  const mine = eq(artifacts.ownerId, user.id);
  const sharedWithMe = email
    ? and(ne(artifacts.ownerId, user.id), sharedIds(email))
    : undefined;
  const team = TEAM_ROLES.includes(user.role)
    ? inArray(artifacts.visibility, ["team", "public"])
    : undefined;
  const parts =
    scope === "mine"
      ? [mine]
      : scope === "shared"
        ? [sharedWithMe]
        : scope === "team"
          ? [team]
          : [mine, sharedWithMe, team];
  const present = parts.filter((p): p is SQL => p !== undefined);
  if (!present.length) return sql`0`;
  // `deleted_at is null` inside every branch: only then does SQLite plan each
  // branch on its partial index (MULTI-INDEX OR) rather than walking all live
  // rows; there are no non-partial owner/visibility indexes (#248).
  const branches = present.map((p) => and(isNull(artifacts.deletedAt), p));
  if (includeDeleted)
    branches.push(
      and(
        isNotNull(artifacts.deletedAt),
        mine,
        ...(present.includes(mine) ? [] : [or(...present)]),
      ),
    );
  return or(...branches) ?? sql`0`;
}

/**
 * `artifacts.id IN (SELECT artifact_id FROM shares WHERE email = ?)`: evaluated
 * once (uncorrelated) via shares_email_idx, not probed per artifact row.
 */
function sharedIds(email: string): SQL {
  return sql`${artifacts.id} in (select ${shares.artifactId} from ${shares} where ${shares.email} = ${email})`;
}
