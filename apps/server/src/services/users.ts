import { type Member, newId, type Role, type UserRef } from "@oa/shared";
import { eq } from "drizzle-orm";
import { withCap } from "../auth/authz.js";
import { getDb } from "../db/client.js";
import { normEmail } from "../db/email.js";
import { shares, users } from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";

type UserRow = typeof users.$inferSelect;
type NameFields = Pick<UserRow, "email" | "name" | "displayName">;

const localPart = (email: string) => email.slice(0, email.lastIndexOf("@"));

/** The IdP name when it is a real name: not blank, not the email's local part (any case). */
export function idpName(name: string | null, email: string): string | null {
  const n = (name ?? "").trim();
  return n && n.toLowerCase() !== localPart(email).toLowerCase() ? n : null;
}

/** The name to render: display name, else a real IdP name, else the full email. Never the bare local part. */
export function effectiveName(u: NameFields): string {
  return u.displayName || idpName(u.name, u.email) || u.email;
}

/**
 * A UserRef for `caller`: anonymous callers get no email, and so no email
 * fallback for the name either (null when the user has no real name).
 */
export function toUserRef(
  u: NameFields & { id: string },
  signedIn: boolean,
): UserRef {
  return signedIn
    ? { id: u.id, email: u.email, name: effectiveName(u) }
    : {
        id: u.id,
        email: null,
        name: u.displayName || idpName(u.name, u.email),
      };
}

export function toMember(
  r: Pick<
    UserRow,
    "id" | "email" | "name" | "displayName" | "role" | "lastSeenAt"
  >,
): Member {
  const email = normEmail(r.email) ?? r.email;
  return {
    id: r.id,
    email,
    name: effectiveName({ ...r, email }),
    role: r.role as Role,
    lastSeenAt:
      r.lastSeenAt == null ? null : new Date(r.lastSeenAt).toISOString(),
  };
}

const defaultName = (email: string) => email.split("@")[0] || email;

/** Insert, or on email conflict force `role` (if given) and refresh name/last_seen_at. */
async function upsert(
  env: Env,
  email: string,
  name: string | null,
  role: Role,
  forceRole: boolean,
): Promise<UserRow> {
  const now = Date.now();
  const set: Partial<UserRow> = { lastSeenAt: now };
  if (name !== null) set.name = name;
  if (forceRole) set.role = role;
  const [row] = await getDb(env)
    .insert(users)
    .values({
      id: newId(),
      email,
      name: name ?? defaultName(email),
      role,
      createdAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({ target: users.email, set })
    .returning();
  if (!row) throw new Error("user upsert returned no row");
  return row;
}

export async function upsertOnLogin(
  env: Env,
  email: string,
  name: string | null,
): Promise<Member | null> {
  // Non-ASCII / malformed emails are no-access: never folded onto an account.
  const e = normEmail(email);
  if (!e) return null;
  const owner = normEmail(env.OWNER_EMAIL ?? "");
  if (owner && e === owner)
    return toMember(await upsert(env, e, name, "owner", true));

  const db = getDb(env);
  const existing = (
    await db.select().from(users).where(eq(users.email, e)).limit(1)
  )[0];
  if (existing) {
    // Deactivated (a guest whose last share went, or P3's sync): no sign-in.
    // A new share reactivates a guest (putShare).
    if (existing.status !== "active") return null;
    const set: Partial<UserRow> = { lastSeenAt: Date.now() };
    if (name !== null) set.name = name;
    const [row] = await db
      .update(users)
      .set(set)
      .where(eq(users.id, existing.id))
      .returning();
    return row ? toMember(row) : null;
  }

  const shared = await db
    .select({ a: shares.artifactId })
    .from(shares)
    .where(eq(shares.email, e))
    .limit(1);
  if (shared.length === 0) return null;
  // Concurrent first logins race on the unique email: the loser just refreshes.
  return toMember(await upsert(env, e, name, "guest", false));
}

/** Dev-only: create or update the user with exactly this role. */
export async function upsertWithRole(
  env: Env,
  email: string,
  role: Role,
): Promise<Member> {
  const e = normEmail(email);
  if (!e) throw new Error("invalid email");
  return toMember(await upsert(env, e, null, role, true));
}

const USER_BY_ID =
  "select id, email, name, display_name as displayName, role, last_seen_at as lastSeenAt from users where id = ? and status = 'active' limit 1";

/**
 * Every authenticated request: one prepared D1 statement, no ORM mapping.
 * A deactivated user (status not 'active') resolves to null, so their session
 * cookie, PATs and OAuth tokens all stop working.
 */
export async function getUser(env: Env, id: string): Promise<Member | null> {
  const row = await stmt(env.DB, USER_BY_ID)
    .bind(id)
    .first<
      Pick<
        UserRow,
        "id" | "email" | "name" | "displayName" | "role" | "lastSeenAt"
      >
    >();
  // Every request's user comes through here (session, PAT, OAuth), so the cap
  // is set once. Sources: P2's authConfig.guestsReadOnly and P3's restriction
  // (users.restricted_*, 0009); until those land nobody is capped.
  return row ? withCap(toMember(row), null) : null;
}

export type Profile = {
  displayName: string | null;
  suggestedName: string | null;
  needsDisplayName: boolean;
};

function toProfile(r: NameFields): Profile {
  const suggestedName = idpName(r.name, r.email);
  return {
    displayName: r.displayName,
    suggestedName,
    needsDisplayName: !r.displayName && !suggestedName,
  };
}

/** Me's name fields. */
export async function getProfile(env: Env, id: string): Promise<Profile> {
  const row = (
    await getDb(env)
      .select({
        email: users.email,
        name: users.name,
        displayName: users.displayName,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
  )[0];
  if (!row) throw new Error("user not found");
  return toProfile(row);
}

/** Sets the user's chosen name (validated by MePatchSchema); sign-in never changes it. */
export async function setDisplayName(
  env: Env,
  id: string,
  displayName: string,
): Promise<{ member: Member; profile: Profile }> {
  const [row] = await getDb(env)
    .update(users)
    .set({ displayName })
    .where(eq(users.id, id))
    .returning();
  if (!row) throw new Error("user not found");
  return { member: toMember(row), profile: toProfile(row) };
}
