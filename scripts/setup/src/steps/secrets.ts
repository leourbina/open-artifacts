import { randomBytes } from "node:crypto";
import type { Ctx, Step } from "../step.ts";
import { linkFor, tokenById } from "../tokens.ts";

export const ACCESS_SECRET = "ACCESS_CLIENT_SECRET";
const GENERATED = ["SESSION_SECRET", "CONTENT_SIGNING_KEY"];
const OPTIONAL = "ANALYTICS_TOKEN";
/** ANALYTICS_TOKEN from the environment (a dedicated token; never CLOUDFLARE_API_TOKEN). */
const envAnalytics = (ctx: Ctx) => ctx.deps.env.ANALYTICS_TOKEN?.trim() || "";

/** Worker secret names. A Worker that doesn't exist yet has none. */
export async function listSecrets(ctx: Ctx): Promise<Set<string>> {
  let out: string;
  try {
    out = await ctx.wrangler([
      "secret",
      "list",
      "--name",
      ctx.opts.name,
      "--format",
      "json",
    ]);
  } catch (e) {
    if (/Worker "[^"]*".* not found/.test((e as Error).message))
      return new Set();
    throw e;
  }
  const list = jsonArray<{ name: string }>(out, "wrangler secret list");
  return new Set(list.map((s) => s.name));
}

/** Parses wrangler JSON output from the first line starting with `[` (banners may hold brackets). */
export function jsonArray<T>(out: string, what: string): T[] {
  const i = out.search(/^\s*\[/m);
  if (i < 0) throw new Error(`\`${what}\` returned no JSON array`);
  return JSON.parse(out.slice(i)) as T[];
}

/**
 * Puts a Worker secret via stdin, never argv. On a Worker that doesn't exist
 * yet, wrangler 4 (non-interactive) first creates an empty draft Worker.
 */
export async function putSecret(ctx: Ctx, name: string, value: string) {
  try {
    await ctx.wrangler(["secret", "put", name, "--name", ctx.opts.name], {
      input: value,
      sensitive: true,
    });
  } catch (e) {
    const escaped = JSON.stringify(value).slice(1, -1);
    const msg = (e as Error).message
      .replaceAll(value, "[redacted]")
      .replaceAll(escaped, "[redacted]");
    throw new Error(`secret put ${name} failed: ${msg}`);
  }
}

const random = () => randomBytes(32).toString("base64url");

export const secrets: Step = {
  name: "secrets",
  async check(state, ctx) {
    // A provided token is put every run, so rotating the source rotates the Worker.
    if (envAnalytics(ctx)) return "todo";
    const have = await listSecrets(ctx);
    const quiet =
      !ctx.opts.interactive || ctx.opts.upgrade || state.analyticsSkipped;
    const done =
      GENERATED.every((n) => have.has(n)) && (quiet || have.has(OPTIONAL));
    return done ? "done" : "todo";
  },
  async apply(state, ctx) {
    const have = await listSecrets(ctx);
    const missing = GENERATED.filter((n) => !have.has(n));
    if (ctx.opts.upgrade && missing.length)
      return {
        status: "action_required",
        message: `Worker secrets missing: ${missing.join(", ")}; --upgrade never generates them, run a full setup first (without --upgrade)`,
      };
    for (const n of GENERATED)
      if (!have.has(n)) await putSecret(ctx, n, random());
    const provided = envAnalytics(ctx);
    if (provided) {
      await putSecret(ctx, OPTIONAL, provided);
      return undefined;
    }
    if (
      have.has(OPTIONAL) ||
      !ctx.opts.interactive ||
      ctx.opts.upgrade ||
      state.analyticsSkipped
    )
      return undefined;
    const q = `${OPTIONAL} for the Usage page (optional). Create a read-only token: ${linkFor(tokenById("analytics", { name: ctx.opts.name }), { accountId: state.accountId })}\nPaste it (input hidden; Enter to skip):`;
    const v = await ctx.deps.prompt(q, { secret: true });
    if (v) await putSecret(ctx, OPTIONAL, v);
    else state.analyticsSkipped = true;
    return undefined;
  },
};
