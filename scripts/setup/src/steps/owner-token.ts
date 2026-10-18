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

/** Same cap as the server (apps/server/src/routes/tokens.ts MAX_ACTIVE). */
const MAX_ACTIVE = 50;

/**
 * One command, in this order (D1 `execute` has no transaction, so a failure
 * keeps earlier effects; the order makes every partial state re-mintable):
 *  0 SELECT the previous owner (reported), 1 demote it to admin, 2 upsert the
 *  owner, 3 capped insert (changes 0 = cap hit), 4 revoke the other live
 *  'setup' tokens (only after the insert, so a failed or capped insert never
 *  leaves the owner without a token), 5 verify the new row.
 * Carries the hash only, never the token.
 */
export function ownerStatements(
  email: string,
  tokenId: string,
  hash: string,
  now: number,
) {
  const name = email.split("@")[0] || email;
  const e = lit(email);
  return [
    `SELECT email FROM users WHERE role = 'owner' AND email <> ${e}`,
    `UPDATE users SET role = 'admin' WHERE role = 'owner' AND email <> ${e}`,
    `INSERT INTO users (id, email, name, role, created_at) VALUES (${lit(base58(16))}, ${e}, ${lit(name)}, 'owner', ${now}) ON CONFLICT(email) DO UPDATE SET role = 'owner'`,
    `INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT ${lit(tokenId)}, id, 'setup', ${lit(hash)}, ${now} FROM users WHERE email = ${e} AND (SELECT count(*) FROM tokens WHERE user_id = users.id AND revoked_at IS NULL) < ${MAX_ACTIVE}`,
    `UPDATE tokens SET revoked_at = ${now} WHERE user_id = (SELECT id FROM users WHERE email = ${e}) AND label = 'setup' AND revoked_at IS NULL AND id <> ${lit(tokenId)} AND EXISTS (SELECT 1 FROM tokens WHERE id = ${lit(tokenId)})`,
    `SELECT id FROM tokens WHERE id = ${lit(tokenId)} AND revoked_at IS NULL`,
  ];
}
export const ownerSql = (...a: Parameters<typeof ownerStatements>) =>
  `${ownerStatements(...a).join("; ")};`;

type D1Result = { results?: unknown[]; meta?: { changes?: number } };
/** Runs SQL on the remote D1; returns one result per statement. */
async function d1Raw(ctx: Ctx, sql: string): Promise<D1Result[]> {
  const db = names(ctx.opts.name).d1;
  const args = ["d1", "execute", db, "--remote", "--json", "--command", sql];
  return jsonArray<D1Result>(await ctx.wrangler(args), "wrangler d1 execute");
}
const d1 = async (ctx: Ctx, sql: string): Promise<unknown[]> =>
  (await d1Raw(ctx, sql)).flatMap((r) => r.results ?? []);

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
    const sql = ownerSql(ctx.opts.ownerEmail, id, tokenHash(token), Date.now());
    const res = await d1Raw(ctx, sql);
    const [before, , , insert, , verify] = res;
    if (!insert?.meta?.changes) {
      state.ownerTokenId = prev;
      writeState(ctx.fs, ctx.root, state);
      return {
        status: "action_required",
        message: `owner has ${MAX_ACTIVE} active tokens; revoke some in Settings, then rerun setup`,
      };
    }
    if (!verify?.results?.length)
      throw new Error(
        `token row ${id} missing after the insert; is ${ctx.opts.ownerEmail} in users? rerun setup`,
      );
    const old = (before?.results ?? []) as { email?: string }[];
    ctx.pat = token;
    ctx.notes.push(
      `minted owner token ${id}${prev ? ` (revoked prior setup tokens, last ${prev})` : ""}; shown once, store it now`,
    );
    for (const o of old)
      ctx.notes.push(`previous owner ${o.email} demoted to admin`);
    ctx.data = { tokenId: id, token };
    ctx.human = `  token: ${token}`;
    return undefined;
  },
};
