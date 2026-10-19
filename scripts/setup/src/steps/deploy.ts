import { join } from "node:path";
import type { Ctx, Step } from "../step.ts";
import { deployedVars, workerBindings } from "../worker.ts";
import { names, stripComments } from "./resources.ts";
import { ACCESS_SECRET, listSecrets } from "./secrets.ts";

const CONFIG = "apps/server/wrangler.jsonc";
const REQUIRED = [ACCESS_SECRET, "SESSION_SECRET", "CONTENT_SIGNING_KEY"];

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

type Rendered = {
  browser?: unknown;
  send_email?: { name: string }[];
  vars?: Record<string, string>;
};

/**
 * Live bindings the rendered config would drop without the matching opt-out
 * flag: a deploy never removes EMAIL, BROWSER or SERVER_THUMBNAILS silently.
 * A failed read only warns.
 */
async function drops(ctx: Ctx, accountId: string, cfg: Rendered) {
  let live: Awaited<ReturnType<typeof workerBindings>>;
  try {
    live = await workerBindings(ctx, accountId);
  } catch (e) {
    ctx.notes.push(
      `warning: could not read the live Worker's bindings (${(e as Error).message}); deploying without the binding check`,
    );
    return [];
  }
  const has = (type: string, name: string) =>
    live?.some((b) => b.type === type && b.name === name) ?? false;
  const out: string[] = [];
  if (
    has("send_email", "EMAIL") &&
    !cfg.send_email?.some((b) => b.name === "EMAIL") &&
    !ctx.opts.noEmail
  )
    out.push(
      "EMAIL (send_email): pass --team (and --yes-paid unless the plan reads paid) to keep it, or --no-email to remove it",
    );
  const lost = [
    has("browser", "BROWSER") && !cfg.browser && "BROWSER",
    has("plain_text", "SERVER_THUMBNAILS") &&
      !cfg.vars?.SERVER_THUMBNAILS &&
      "SERVER_THUMBNAILS",
  ].filter(Boolean);
  if (lost.length && ctx.opts.browserFlag !== false)
    out.push(
      `${lost.join(" and ")} (thumbnails): pass --browser to keep them, or --no-browser to remove them`,
    );
  return out;
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
  always: true,
  async check(state, ctx) {
    // Under --check, a never-deployed Worker is real drift, not the every-run deploy.
    if (ctx.opts.check && !(await deployedVars(ctx, state.accountId ?? ""))) {
      ctx.mustRun = true;
      ctx.notes.push(`Worker ${ctx.opts.name} never deployed`);
    }
    return "todo";
  },
  async apply(state, ctx) {
    const vars = renderedVars(ctx);
    const cfg = JSON.parse(
      stripComments(ctx.fs.read(join(ctx.root, CONFIG)) ?? "{}"),
    ) as Rendered;
    const dropped = await drops(ctx, state.accountId ?? "", cfg);
    if (dropped.length)
      throw new Error(
        `refusing to deploy: the live Worker has bindings this config would drop: ${dropped.join("; ")}`,
      );
    const have = await listSecrets(ctx);
    const missing = REQUIRED.filter((n) => !have.has(n));
    if (missing.length)
      throw new Error(
        `refusing to deploy: Worker secrets missing: ${missing.join(", ")}; rerun setup without --upgrade`,
      );
    const build = ["--dir", ctx.root, "--filter", "@oa/server...", "build"];
    const b = await ctx.deps.exec("pnpm", build);
    if (b.code !== 0)
      throw new Error(`pnpm build failed: ${(b.stderr || b.stdout).trim()}`);
    // A secret with a var's name makes `wrangler deploy` fail: drop the secret.
    for (const n of Object.keys(vars).filter((k) => have.has(k))) {
      await ctx.wrangler(["secret", "delete", n, "--name", ctx.opts.name], {
        input: "y\n",
      });
      ctx.notes.push(`deleted Worker secret ${n} (shadowed the var)`);
    }
    const d1 = names(ctx.opts.name).d1;
    await ctx.wrangler(["d1", "migrations", "apply", d1, "--remote"]);
    await ctx.wrangler(["deploy"]);
    state.deployedVersion = repoVersion(ctx);
    ctx.notes.push(`deployed ${state.deployedVersion}`);
    ctx.data = { deployedVersion: state.deployedVersion };
    return undefined;
  },
};
