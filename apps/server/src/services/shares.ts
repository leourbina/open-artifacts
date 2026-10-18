import type { Member, Share, ShareRole } from "@oa/shared";
import { and, asc, eq } from "drizzle-orm";
import { requireAccess } from "../auth/authz.js";
import { getDb } from "../db/client.js";
import { normEmail } from "../db/email.js";
import { shares } from "../db/schema.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";

export const MAX_SHARES = 200;

const toShare = (r: {
  email: string;
  role: string;
  createdAt: number;
}): Share => ({
  email: r.email,
  role: r.role as ShareRole,
  createdAt: new Date(r.createdAt).toISOString(),
});

const ownerOnly = (env: Env, user: Member, id: string) =>
  requireAccess(env, { kind: "user", user }, id, "owner");

export async function listShares(
  env: Env,
  user: Member,
  id: string,
): Promise<Share[]> {
  await ownerOnly(env, user, id);
  const rows = await getDb(env)
    .select()
    .from(shares)
    .where(eq(shares.artifactId, id))
    .orderBy(asc(shares.createdAt), asc(shares.email))
    .limit(MAX_SHARES);
  return rows.map(toShare);
}

/** Upsert (owner-only). Sharing only ever adds access; see accessLevel. */
export async function putShare(
  env: Env,
  user: Member,
  id: string,
  s: { email: string; role: ShareRole },
): Promise<Share> {
  await ownerOnly(env, user, id);
  const email = normEmail(s.email);
  if (!email) throw new ApiError("bad_request", "Invalid email");
  if (email === normEmail(user.email))
    throw new ApiError("bad_request", "Cannot share with yourself");
  // One atomic statement: a new email is inserted only while under the cap;
  // updating an existing share bypasses it.
  const row = await env.DB.prepare(
    `INSERT INTO shares (artifact_id, email, role, created_by, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE (SELECT count(*) FROM shares WHERE artifact_id = ?1) < ?6
        OR EXISTS (SELECT 1 FROM shares WHERE artifact_id = ?1 AND email = ?2)
     ON CONFLICT (artifact_id, email) DO UPDATE SET role = excluded.role
     RETURNING email, role, created_at AS createdAt`,
  )
    .bind(id, email, s.role, user.id, Date.now(), MAX_SHARES)
    .first<{ email: string; role: string; createdAt: number }>();
  if (!row)
    throw new ApiError(
      "bad_request",
      `At most ${MAX_SHARES} shares per artifact`,
    );
  return toShare(row);
}

export async function deleteShare(
  env: Env,
  user: Member,
  id: string,
  email: string,
): Promise<void> {
  await ownerOnly(env, user, id);
  const e = normEmail(email);
  if (!e) throw new ApiError("not_found", "Not found");
  const out = await getDb(env)
    .delete(shares)
    .where(and(eq(shares.artifactId, id), eq(shares.email, e)))
    .returning({ e: shares.email });
  if (out.length === 0) throw new ApiError("not_found", "Not found");
}
