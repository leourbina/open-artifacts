import { randomBytes } from "node:crypto";
import type { Ctx, Step } from "../step.ts";

export const ACCESS_SECRET = "ACCESS_CLIENT_SECRET";
const GENERATED = ["SESSION_SECRET", "CONTENT_SIGNING_KEY"];
const OPTIONAL = "ANALYTICS_TOKEN";

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
    const have = await listSecrets(ctx);
    const quiet = ctx.opts.yes || ctx.opts.upgrade || state.analyticsSkipped;
    const done =
      GENERATED.every((n) => have.has(n)) && (quiet || have.has(OPTIONAL));
    return done ? "done" : "todo";
  },
  async apply(state, ctx) {
    const have = await listSecrets(ctx);
    for (const n of GENERATED)
      if (!have.has(n)) await putSecret(ctx, n, random());
    if (
      have.has(OPTIONAL) ||
      ctx.opts.yes ||
      ctx.opts.upgrade ||
      state.analyticsSkipped
    )
      return undefined;
    const q = `${OPTIONAL} (optional, input hidden; Enter to skip):`;
    const v = await ctx.deps.prompt(q, { secret: true });
    if (v) await putSecret(ctx, OPTIONAL, v);
    else state.analyticsSkipped = true;
    return undefined;
  },
};
