import { createHash, randomInt } from "node:crypto";
import type { Ctx, Step } from "../step.ts";
import { names } from "./resources.ts";

// Same format as @oa/shared newId/newPat (base58); test/deploy.test.ts checks isPat.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (n: number) =>
  Array.from({ length: n }, () => B58[randomInt(58)]).join("");
export const newPat = () => `oa_pat_${base58(32)}`;
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
/** SQLite string literal. */
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Upserts the owner (role forced to owner) and inserts the token row: hash only. */
export function ownerSql(
  email: string,
  tokenId: string,
  hash: string,
  now: number,
) {
  const name = email.split("@")[0] || email;
  return [
    `INSERT INTO users (id, email, name, role, created_at) VALUES (${lit(base58(16))}, ${lit(email)}, ${lit(name)}, 'owner', ${now}) ON CONFLICT(email) DO UPDATE SET role = 'owner';`,
    `INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT ${lit(tokenId)}, id, 'setup', ${lit(hash)}, ${now} FROM users WHERE email = ${lit(email)};`,
  ].join(" ");
}

/** Runs SQL on the remote D1; returns the result rows. */
async function d1(ctx: Ctx, sql: string): Promise<unknown[]> {
  const db = names(ctx.opts.name).d1;
  const out = await ctx.wrangler([
    "d1",
    "execute",
    db,
    "--remote",
    "--json",
    "--command",
    sql,
  ]);
  const i = out.indexOf("[");
  if (i < 0) throw new Error("`wrangler d1 execute` returned no JSON array");
  const res = JSON.parse(out.slice(i)) as { results?: unknown[] }[];
  return res.flatMap((r) => r.results ?? []);
}

export const ownerToken: Step = {
  name: "owner-token",
  async check(state, ctx) {
    if (ctx.opts.newOwnerToken) return "todo";
    if (ctx.opts.upgrade) {
      ctx.notes.push("kept (--upgrade); pass --new-owner-token to mint one");
      return "done";
    }
    if (!state.ownerTokenId) return "todo";
    const sql = `SELECT id FROM tokens WHERE id = ${lit(state.ownerTokenId)} AND revoked_at IS NULL;`;
    if (!(await d1(ctx, sql)).length) return "todo";
    ctx.notes.push(
      `token ${state.ownerTokenId} exists; pass --new-owner-token to mint another`,
    );
    return "done";
  },
  async apply(state, ctx) {
    const token = newPat();
    const id = base58(16);
    const hash = sha256Hex(token);
    await d1(ctx, ownerSql(ctx.opts.ownerEmail, id, hash, Date.now()));
    state.ownerTokenId = id;
    ctx.pat = token;
    ctx.notes.push(`minted owner token ${id}; shown once, store it now`);
    ctx.data = { tokenId: id, token };
    ctx.human = `  token: ${token}`;
    return undefined;
  },
};
