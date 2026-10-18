import { join } from "node:path";
import type { Ctx, Step } from "../step.ts";
import { names, stripComments } from "./resources.ts";
import { ACCESS_SECRET, listSecrets } from "./secrets.ts";

const CONFIG = "apps/server/wrangler.jsonc";
const REQUIRED = [ACCESS_SECRET, "SESSION_SECRET", "CONTENT_SIGNING_KEY"];
const DASH = "apps/dashboard/dist/index.html";

/** The rendered config's vars, refusing anything that isn't a complete production config. */
function renderedVars(ctx: Ctx): Record<string, string> {
  const text = ctx.fs.read(join(ctx.root, CONFIG));
  if (text === null) throw new Error(`missing ${CONFIG}; rerun setup`);
  const vars = JSON.parse(stripComments(text)).vars ?? {};
  if (vars.ENVIRONMENT !== "production")
    throw new Error(
      `refusing to deploy: ${CONFIG} has ENVIRONMENT=${JSON.stringify(vars.ENVIRONMENT)}, expected "production"`,
    );
  const empty = ["ACCESS_TEAM_DOMAIN", "ACCESS_CLIENT_ID"].filter(
    (k) => !vars[k],
  );
  if (empty.length)
    throw new Error(
      `refusing to deploy: ${CONFIG} has empty ${empty.join(", ")}; rerun setup without --upgrade so the access step fills them`,
    );
  return vars;
}

/** The repo version: root package.json, else the release-please manifest. */
function repoVersion(ctx: Ctx): string {
  const json = (p: string) =>
    JSON.parse(ctx.fs.read(join(ctx.root, p)) ?? "{}");
  return (
    json("package.json").version ??
    json(".release-please-manifest.json")["."] ??
    "0.0.0"
  );
}

export const deploy: Step = {
  name: "deploy",
  check: async () => "todo",
  async apply(state, ctx) {
    const vars = renderedVars(ctx);
    const have = await listSecrets(ctx);
    const missing = REQUIRED.filter((n) => !have.has(n));
    if (missing.length)
      throw new Error(
        `refusing to deploy: Worker secrets missing: ${missing.join(", ")}; rerun setup without --upgrade`,
      );
    // A secret with a var's name makes `wrangler deploy` fail: drop the secret.
    for (const n of Object.keys(vars).filter((k) => have.has(k))) {
      await ctx.wrangler(["secret", "delete", n, "--name", ctx.opts.name], {
        input: "y\n",
      });
      ctx.notes.push(`deleted Worker secret ${n} (shadowed the var)`);
    }
    const b = await ctx.deps.exec("pnpm", ["--dir", ctx.root, "build"]);
    if (b.code !== 0)
      throw new Error(`pnpm build failed: ${(b.stderr || b.stdout).trim()}`);
    // The dashboard has no build yet; assets need a directory (as CI does).
    if (ctx.fs.read(join(ctx.root, DASH)) === null)
      ctx.fs.write(
        join(ctx.root, DASH),
        "<!doctype html><title>Open Artifacts</title>\n",
      );
    const d1 = names(ctx.opts.name).d1;
    await ctx.wrangler(["d1", "migrations", "apply", d1, "--remote"]);
    await ctx.wrangler(["deploy"]);
    state.deployedVersion = repoVersion(ctx);
    ctx.notes.push(`deployed ${state.deployedVersion}`);
    ctx.data = { deployedVersion: state.deployedVersion };
    return undefined;
  },
};
