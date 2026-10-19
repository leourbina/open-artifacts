import { join } from "node:path";
import type { State } from "../state.ts";
import type { Ctx, Step } from "../step.ts";
import { currentVersion, deployedVars, workerBindings } from "../worker.ts";
import { names, renderedConfig, stripComments } from "./resources.ts";
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
async function readLive(ctx: Ctx, accountId: string): Promise<Live> {
  try {
    return await workerBindings(ctx, accountId);
  } catch (e) {
    ctx.notes.push(
      `warning: could not read the live Worker's bindings (${(e as Error).message}); deploying without the binding check`,
    );
    return "unreadable";
  }
}

function drops(ctx: Ctx, live: Live, cfg: Rendered) {
  if (live === "unreadable") return [];
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

/** The live Worker version id; a failed read only warns, and never blocks the deploy. */
async function readVersion(ctx: Ctx, state: State) {
  try {
    return await currentVersion(ctx, state.accountId ?? "");
  } catch (e) {
    ctx.notes.push(
      `warning: could not read the live Worker version (${(e as Error).message}); --rollback may have no target`,
    );
    return undefined;
  }
}

type Live = Awaited<ReturnType<typeof workerBindings>> | "unreadable";

/**
 * A deploy never turns a live (or last-deployed) paid PLAN into free unless
 * asked with --plan free: an unreadable plan must not downgrade prod. The live
 * PLAN var wins; with an unreadable Worker only the saved value (written after
 * a successful deploy) counts, and with neither, refuse (a 404 is "no Worker", not unreadable).
 */
function planGuard(
  state: State,
  ctx: Ctx,
  vars: Record<string, string>,
  live: Live,
): string | undefined {
  if (vars.PLAN === "paid" || ctx.opts.planFlag === "free") return undefined;
  const fix =
    "Pass --plan paid to keep it, or --plan free to downgrade on purpose";
  const why =
    state.plan === "unknown"
      ? "from a plan setup could not confirm"
      : `plan read as ${state.plan}`;
  const refuse = (what: string) =>
    `refusing to deploy: ${what} but this run would render PLAN ${JSON.stringify(vars.PLAN)} (${why}). ${fix}`;
  if (live === "unreadable") {
    if (state.planVar === "paid")
      return refuse(
        "the saved PLAN is paid and the live Worker could not be read",
      );
    if (state.planVar === undefined)
      return refuse(
        "the live Worker's PLAN could not be read and none is saved",
      );
    return undefined;
  }
  const lp = live?.find((b) => b.type === "plain_text" && b.name === "PLAN");
  if (lp?.text?.trim().toLowerCase() === "paid" || state.planVar === "paid")
    return refuse("the Worker's PLAN is paid");
  return undefined;
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
    // A pending downgrade refusal is drift too: report it instead of a clean check.
    if (ctx.opts.check) {
      try {
        const vars = JSON.parse(stripComments(renderedConfig(state, ctx))).vars;
        const g = planGuard(
          state,
          ctx,
          vars,
          await readLive(ctx, state.accountId ?? ""),
        );
        if (g) {
          ctx.mustRun = true;
          ctx.notes.push(g);
        }
      } catch {}
    }
    return "todo";
  },
  async apply(state, ctx) {
    const vars = renderedVars(ctx);
    const cfg = JSON.parse(
      stripComments(ctx.fs.read(join(ctx.root, CONFIG)) ?? "{}"),
    ) as Rendered;
    const live = await readLive(ctx, state.accountId ?? "");
    const dropped = drops(ctx, live, cfg);
    if (dropped.length)
      throw new Error(
        `refusing to deploy: the live Worker has bindings this config would drop: ${dropped.join("; ")}`,
      );
    const guard = planGuard(state, ctx, vars, live);
    if (guard) return { status: "action_required", message: guard };
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
    const replaced = await readVersion(ctx, state);
    await ctx.wrangler(["deploy"]);
    if (replaced) state.previousWorkerVersion = replaced;
    const now = await readVersion(ctx, state);
    if (now) state.workerVersion = now;
    state.deployedVersion = repoVersion(ctx);
    state.planVar = ctx.opts.planVar;
    ctx.notes.push(`deployed ${state.deployedVersion}`);
    ctx.data = { deployedVersion: state.deployedVersion };
    return undefined;
  },
};
