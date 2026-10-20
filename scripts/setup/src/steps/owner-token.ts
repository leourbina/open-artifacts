import { createHash, randomInt } from "node:crypto";
import { homeOf, patTokenFile } from "../secret-file.ts";
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
 * Command 1 (D1 `execute` has no transaction, so a failure keeps earlier
 * effects; the order makes every partial state re-mintable):
 *  0 upsert the owner, 1 capped insert (changes 0 = cap hit), 2 verify the
 *  new row.
 * The old tokens are revoked only by command 2 (revokePriorSql), after the new
 * token is safely in its file: a capped or failed insert or a failed file
 * write never leaves the owner without a working token. Cost: a leftover
 * setup token counts toward the cap.
 * Carries the hash only, never the token.
 */
export function ownerStatements(
  email: string,
  tokenId: string,
  hash: string,
  now: number,
  label = "setup",
  cleanStale = false,
) {
  const name = email.split("@")[0] || email;
  const e = lit(email);
  const stale = cleanStale
    ? [
        // --ci: leaked setup-ci tokens (SIGKILL/OOM) must not count toward the cap, so they go BEFORE the insert.
        // Safe because CI runs are serialized (workflow `concurrency: prod`): no concurrent run's live token is hit.
        revokeCiSql(email, now),
      ]
    : [];
  const [upsert, ...rest] = [
    `INSERT INTO users (id, email, name, role, created_at) VALUES (${lit(base58(16))}, ${e}, ${lit(name)}, 'owner', ${now}) ON CONFLICT(email) DO UPDATE SET role = 'owner'`,
    `INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT ${lit(tokenId)}, id, ${lit(label)}, ${lit(hash)}, ${now} FROM users WHERE email = ${e} AND (SELECT count(*) FROM tokens WHERE user_id = users.id AND revoked_at IS NULL) < ${MAX_ACTIVE}`,
    `SELECT id FROM tokens WHERE id = ${lit(tokenId)} AND revoked_at IS NULL`,
  ];
  return [upsert, ...stale, ...rest] as string[];
}

/** Revokes the owner's other live tokens with this label, once the new row exists. */
export const revokePriorSql = (
  email: string,
  tokenId: string,
  now: number,
  label = "setup",
) =>
  `UPDATE tokens SET revoked_at = ${now} WHERE user_id = (SELECT id FROM users WHERE email = ${lit(email)}) AND label = ${lit(label)} AND revoked_at IS NULL AND id <> ${lit(tokenId)} AND EXISTS (SELECT 1 FROM tokens WHERE id = ${lit(tokenId)})`;

/** Revokes every live 'setup-ci' token of the owner. */
export const revokeCiSql = (email: string, now: number) =>
  `UPDATE tokens SET revoked_at = ${now} WHERE user_id = (SELECT id FROM users WHERE email = ${lit(email)}) AND label = 'setup-ci' AND revoked_at IS NULL`;

/** --revoke-ci-tokens: returns how many rows were revoked. */
export async function revokeCiTokens(ctx: Ctx): Promise<number> {
  const res = await d1Raw(
    ctx,
    `${revokeCiSql(ctx.opts.ownerEmail, Date.now())};`,
  );
  return res[0]?.meta?.changes ?? 0;
}
export const ownerSql = (...a: Parameters<typeof ownerStatements>) =>
  `${ownerStatements(...a).join("; ")};`;

/** Command 2, only after the insert succeeded: select, demote, verify. */
export function demoteStatements(email: string) {
  const e = lit(email);
  return [
    `SELECT email FROM users WHERE role = 'owner' AND email <> ${e}`,
    `UPDATE users SET role = 'admin' WHERE role = 'owner' AND email <> ${e}`,
    `SELECT email FROM users WHERE role = 'owner' AND email = ${e}`,
  ];
}

type D1Result = { results?: unknown[]; meta?: { changes?: number } };
/** Runs SQL on the remote D1; returns one result per statement. */
async function d1Raw(ctx: Ctx, sql: string): Promise<D1Result[]> {
  const db = names(ctx.opts.name).d1;
  const args = ["d1", "execute", db, "--remote", "--json", "--command", sql];
  return jsonArray<D1Result>(await ctx.wrangler(args), "wrangler d1 execute");
}
const d1 = async (ctx: Ctx, sql: string): Promise<unknown[]> =>
  (await d1Raw(ctx, sql)).flatMap((r) => r.results ?? []);

/** --ci: revokes the run's own token row (hash-only; idempotent). */
export async function revokeToken(ctx: Ctx, id: string) {
  await d1Raw(
    ctx,
    `UPDATE tokens SET revoked_at = ${Date.now()} WHERE id = ${lit(id)} AND revoked_at IS NULL;`,
  );
}

const live = (ctx: Ctx, id: string) =>
  d1(
    ctx,
    `SELECT id FROM tokens WHERE id = ${lit(id)} AND revoked_at IS NULL;`,
  ).then((rows) => rows.length > 0);

/** Where this run's PAT file lives (an absolute path). */
const tokenFileOf = (ctx: Ctx) =>
  patTokenFile(homeOf(ctx.deps.env), ctx.opts.appHost);

export const ownerToken: Step = {
  name: "owner-token",
  async check(state, ctx) {
    if (ctx.opts.newOwnerToken) return "todo";
    if (ctx.opts.upgrade) {
      ctx.notes.push("kept (--upgrade); pass --new-owner-token to mint one");
      return "done";
    }
    if (ctx.opts.ci) return "todo";
    if (!state.ownerTokenId || !(await live(ctx, state.ownerTokenId)))
      return "todo";
    if (ctx.fs.read(tokenFileOf(ctx)) === null) {
      ctx.notes.push("the token file is missing; rerun with --new-owner-token");
      return "todo";
    }
    ctx.notes.push(
      `token ${state.ownerTokenId} exists; pass --new-owner-token to mint another`,
    );
    return "done";
  },
  async apply(state, ctx) {
    const token = newPat();
    const id = base58(16);
    const ci = ctx.opts.ci;
    const prev = state.ownerTokenId;
    // Recorded first, so a crash after the insert still leaves the row tracked.
    // Under --ci the id is tracked in ctx only (state is never written) and revoked at the end.
    if (ci) ctx.ciTokenId = id;
    else {
      state.ownerTokenId = id;
      writeState(ctx.fs, ctx.root, state);
    }
    const untrack = () => {
      if (ci) return;
      state.ownerTokenId = prev;
      writeState(ctx.fs, ctx.root, state);
    };
    const uncertain = () => {
      untrack();
      return {
        status: "action_required" as const,
        message: "owner token state uncertain; rerun with --new-owner-token",
      };
    };
    const email = ctx.opts.ownerEmail;
    const label = ci ? "setup-ci" : "setup";
    let res: D1Result[];
    try {
      res = await d1Raw(
        ctx,
        ownerSql(email, id, tokenHash(token), Date.now(), label, ci),
      );
    } catch {
      return uncertain();
    }
    const o = ci ? 1 : 0; // --ci has one extra statement (stale cleanup) before the insert
    if (res.length < 3 + o) return uncertain();
    const [insert, verify] = [res[1 + o], res[2 + o]];
    if (!insert?.meta?.changes) {
      untrack();
      return {
        status: "action_required",
        message: `owner has ${MAX_ACTIVE} active tokens; revoke some in Settings, then rerun setup (an old setup token still counts toward the cap; revoke it in Settings)`,
      };
    }
    if (!verify?.results?.length)
      throw new Error(
        `token row ${id} missing after the insert; is ${email} in users? rerun setup`,
      );
    ctx.pat = token;
    // The new token goes to its file BEFORE the old one is revoked, so a failed
    // write leaves the old token (and its file) valid. Not under --ci: that
    // token is revoked at the end of the run, so a file would only go stale.
    let tokenFile: string | undefined;
    if (!ci) {
      tokenFile = tokenFileOf(ctx);
      try {
        if (!ctx.fs.writeSecret)
          throw new Error("this fs cannot write secret files");
        ctx.fs.writeSecret(tokenFile, `${token}\n`);
      } catch (e) {
        ctx.pat = undefined;
        // Retire the unusable new row; the old token stays valid.
        await revokeToken(ctx, id).catch(() => {});
        untrack();
        throw new Error(
          `could not save the new owner token to ${tokenFile} (${(e as Error).message}); the previous token is unchanged; fix that and rerun with --new-owner-token`,
        );
      }
    }
    ctx.notes.push(
      ci
        ? "owner token minted for selftest (not printed; revoked at end of run)"
        : `minted owner token ${id}; saved to ${tokenFile} (don't read or print it; point your client config at it)`,
    );
    const stale = ci ? (res[1]?.meta?.changes ?? 0) : 0;
    if (stale > 0) ctx.notes.push(`revoked ${stale} stale setup-ci tokens`);
    try {
      const out = await d1Raw(
        ctx,
        `${[
          revokePriorSql(email, id, Date.now(), label),
          ...demoteStatements(email),
        ].join("; ")};`,
      );
      const revoked = out[0]?.meta?.changes ?? 0;
      if (revoked > 0)
        ctx.notes.push(`revoked ${revoked} prior ${label} tokens`);
      for (const o of (out[1]?.results ?? []) as { email?: string }[])
        ctx.notes.push(`previous owner ${o.email} demoted to admin`);
    } catch {
      ctx.notes.push(
        "could not revoke the previous token or demote the previous owner; rerun with --new-owner-token",
      );
    }
    if (ci) {
      ctx.data = { tokenId: id };
      return undefined;
    }
    ctx.data = {
      tokenId: id,
      tokenFile,
      ...(ctx.opts.printToken ? { token } : {}),
    };
    if (ctx.opts.printToken) ctx.human = `  token: ${token}`;
    return undefined;
  },
};
