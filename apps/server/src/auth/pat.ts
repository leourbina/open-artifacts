import { isPat, newId, newPat } from "@oa/shared";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { tokens } from "../db/schema.js";
import type { Env } from "../env.js";
import { sha256Hex } from "../util/crypto.js";

const HOUR = 3600 * 1000;

export async function createPat(
  env: Env,
  userId: string,
  label: string,
): Promise<{ id: string; token: string }> {
  const id = newId();
  const token = newPat();
  await getDb(env)
    .insert(tokens)
    .values({
      id,
      userId,
      label,
      tokenHash: await sha256Hex(token),
      createdAt: Date.now(),
    });
  return { id, token };
}

export async function verifyPat(
  env: Env,
  token: string,
  ctx?: ExecutionContext,
): Promise<{ userId: string; tokenId: string; label: string } | null> {
  if (!isPat(token)) return null;
  const db = getDb(env);
  const row = (
    await db
      .select()
      .from(tokens)
      .where(eq(tokens.tokenHash, await sha256Hex(token)))
      .limit(1)
  )[0];
  if (!row || row.revokedAt != null) return null;
  const now = Date.now();
  if (row.lastUsedAt == null || row.lastUsedAt < now - HOUR) {
    const upd = db
      .update(tokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(tokens.id, row.id),
          or(isNull(tokens.lastUsedAt), lt(tokens.lastUsedAt, now - HOUR)),
        ),
      )
      .then(() => undefined);
    if (ctx) ctx.waitUntil(upd);
    else await upd;
  }
  return { userId: row.userId, tokenId: row.id, label: row.label };
}
