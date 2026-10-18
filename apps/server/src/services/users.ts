import { type Member, newId, type Role } from "@oa/shared";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { normEmail } from "../db/email.js";
import { shares, users } from "../db/schema.js";
import type { Env } from "../env.js";

type UserRow = typeof users.$inferSelect;

export function toMember(r: UserRow): Member {
  return {
    id: r.id,
    email: normEmail(r.email) ?? r.email,
    name: r.name || null,
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

export async function getUser(env: Env, id: string): Promise<Member | null> {
  const row = (
    await getDb(env).select().from(users).where(eq(users.id, id)).limit(1)
  )[0];
  return row ? toMember(row) : null;
}
