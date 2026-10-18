import { createHash, randomInt } from "node:crypto";
import { writeState } from "../state.ts";
import type { Ctx, Step } from "../step.ts";
import { names } from "./resources.ts";
import { jsonArray } from "./secrets.ts";

// Same format as @oa/shared newId/newPat (base58); test/deploy.test.ts checks isId/isPat.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (n: number) =>
  Array.from({ length: n }, () => B58[randomInt(58)]).join("");
export const newPat = () => `oa_pat_${base58(32)}`;
/** Same as the server's sha256Hex (apps/server/src/util/crypto.ts). */
export const tokenHash = (s: string) =>
  createHash("sha256").update(s).digest("hex");
/** SQLite string literal. */
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * Revokes the previous setup token (if any), upserts the owner (role forced to
 * owner) and inserts the new token row. Carries the hash only, never the token.
 */
export function ownerSql(
  email: string,
  tokenId: string,
  hash: string,
  now: number,
  revoke?: string,
) {
  const name = email.split("@")[0] || email;
  return [
    ...(revoke
      ? [
          `UPDATE tokens SET revoked_at = ${now} WHERE id = ${lit(revoke)} AND revoked_at IS NULL;`,
        ]
      : []),
    `INSERT INTO users (id, email, name, role, created_at) VALUES (${lit(base58(16))}, ${lit(email)}, ${lit(name)}, 'owner', ${now}) ON CONFLICT(email) DO UPDATE SET role = 'owner';`,
    `INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT ${lit(tokenId)}, id, 'setup', ${lit(hash)}, ${now} FROM users WHERE email = ${lit(email)};`,
  ].join(" ");
}

/** Runs SQL on the remote D1; returns the result rows. */
async function d1(ctx: Ctx, sql: string): Promise<unknown[]> {
  const db = names(ctx.opts.name).d1;
  const args = ["d1", "execute", db, "--remote", "--json", "--command", sql];
  const res = jsonArray<{ results?: unknown[] }>(
    await ctx.wrangler(args),
    "wrangler d1 execute",
  );
  return res.flatMap((r) => r.results ?? []);
}

const live = (ctx: Ctx, id: string) =>
  d1(
    ctx,
    `SELECT id FROM tokens WHERE id = ${lit(id)} AND revoked_at IS NULL;`,
  ).then((rows) => rows.length > 0);

export const ownerToken: Step = {
  name: "owner-token",
  async check(state, ctx) {
    if (ctx.opts.newOwnerToken) return "todo";
    if (ctx.opts.upgrade) {
      ctx.notes.push("kept (--upgrade); pass --new-owner-token to mint one");
      return "done";
    }
    if (!state.ownerTokenId || !(await live(ctx, state.ownerTokenId)))
      return "todo";
    ctx.notes.push(
      `token ${state.ownerTokenId} exists; pass --new-owner-token to mint another`,
    );
    return "done";
  },
  async apply(state, ctx) {
    const token = newPat();
    const id = base58(16);
    const prev = state.ownerTokenId;
    // Recorded first, so a crash after the insert still leaves the row tracked.
    state.ownerTokenId = id;
    writeState(ctx.fs, ctx.root, state);
    const sql = ownerSql(
      ctx.opts.ownerEmail,
      id,
      tokenHash(token),
      Date.now(),
      prev,
    );
    await d1(ctx, sql);
    if (!(await live(ctx, id)))
      throw new Error(
        `token row ${id} missing after the insert; is ${ctx.opts.ownerEmail} in users? rerun setup`,
      );
    ctx.pat = token;
    ctx.notes.push(
      `minted owner token ${id}${prev ? ` (revoked ${prev})` : ""}; shown once, store it now`,
    );
    ctx.data = { tokenId: id, token };
    ctx.human = `  token: ${token}`;
    return undefined;
  },
};
