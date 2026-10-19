import {
  type Format,
  type Member,
  type Share,
  type ShareResult,
  type ShareRole,
  viewerPath,
} from "@oa/shared";
import { and, asc, eq } from "drizzle-orm";
import { requireAccess } from "../auth/authz.js";
import { getDb } from "../db/client.js";
import { normEmail } from "../db/email.js";
import { shares } from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import { emailEnabled, sendEmail } from "../email/send.js";
import { shareEmail } from "../email/templates.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { closeRuntimeSockets } from "../runtime/revoke.js";
import { getSettings } from "./members.js";

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

const IS_USER = "select 1 as x from users where email = ? limit 1";

/**
 * Upsert (owner-only). Sharing only ever adds access; see accessLevel.
 * A new share with a non-member is emailed a link (best effort).
 */
export async function putShare(
  env: Env,
  user: Member,
  id: string,
  s: { email: string; role: ShareRole },
): Promise<ShareResult> {
  const artifact = await ownerOnly(env, user, id);
  const email = normEmail(s.email);
  if (!email) throw new ApiError("bad_request", "Invalid email");
  if (email === normEmail(user.email))
    throw new ApiError("bad_request", "Cannot share with yourself");
  const now = Date.now();
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
    .bind(id, email, s.role, user.id, now, MAX_SHARES)
    .first<{ email: string; role: string; createdAt: number }>();
  if (!row)
    throw new ApiError(
      "bad_request",
      `At most ${MAX_SHARES} shares per artifact`,
    );
  // An update keeps the original created_at, so this is a new share.
  const created = row.createdAt === now;
  return {
    ...toShare(row),
    emailed: created && (await emailShare(env, user, artifact, email, s.role)),
  };
}

async function emailShare(
  env: Env,
  user: Member,
  artifact: { id: string; title: string; format: string },
  email: string,
  role: ShareRole,
): Promise<boolean> {
  if (!emailEnabled(env)) return false;
  try {
    const [member, settings] = await Promise.all([
      stmt(env.DB, IS_USER).bind(email).first(),
      getSettings(env),
    ]);
    if (member) return false;
    return await sendEmail(
      env,
      user.id,
      email,
      () =>
        shareEmail({
          inviter: user.name || user.email,
          instance: settings.name,
          recipient: email,
          appHost: env.APP_HOST,
          title: artifact.title,
          path: viewerPath(artifact.id),
          format: artifact.format as Format,
          role,
        }),
      { artifactId: artifact.id },
    );
  } catch {
    return false;
  }
}

export async function deleteShare(
  env: Env,
  user: Member,
  id: string,
  email: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  await ownerOnly(env, user, id);
  const e = normEmail(email);
  if (!e) throw new ApiError("not_found", "Not found");
  const out = await getDb(env)
    .delete(shares)
    .where(and(eq(shares.artifactId, id), eq(shares.email, e)))
    .returning({ e: shares.email });
  if (out.length === 0) throw new ApiError("not_found", "Not found");
  await closeRuntimeSockets(env, [id], "share revoked", ctx);
}
