import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type Deps, makeApi, makeWrangler, realDeps, realFs } from "./cf.ts";
import { readState, type State, writeState } from "./state.ts";
import type { Ctx, Opts, Step } from "./step.ts";
import { prereqs } from "./steps/prereqs.ts";
import { resources } from "./steps/resources.ts";

// access, secrets, deploy, owner-token, selftest, agent-config: B16-2/B16-3.
export const STEPS: Step[] = [prereqs, resources];

type Line = {
  step: string;
  status: "ok" | "skipped" | "action_required" | "error";
  message: string;
  data?: unknown;
};
const ICON = { ok: "✓", skipped: "·", action_required: "!", error: "✗" };

const HOST = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const EMAIL = /^[^\s@"\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const NAME = /^[a-z0-9-]+$/;

function valid(flag: string, val: string, re: RegExp) {
  if (!re.test(val)) throw new Error(`invalid ${flag}: ${JSON.stringify(val)}`);
  return val;
}

async function resolve(argv: string[], deps: Deps, state: State) {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      name: { type: "string" },
      "app-host": { type: "string" },
      "content-host": { type: "string" },
      "owner-email": { type: "string" },
      "account-id": { type: "string" },
      yes: { type: "boolean", default: false },
      upgrade: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  // Precedence: flag, then saved state, then an interactive prompt.
  const need = async (flag: string, re: RegExp, saved?: string) => {
    const q = `${flag.slice(2).replace("-", " ")}:`;
    const val =
      (v[flag.slice(2) as keyof typeof v] as string | undefined) ??
      saved ??
      (v.yes ? undefined : await deps.prompt(q));
    if (!val) throw new Error(`missing ${flag} (required with --yes)`);
    return valid(flag, val, re);
  };
  const name = valid("--name", v.name ?? state.name ?? "open-artifacts", NAME);
  if (state.name && name !== state.name) {
    const q = `State is for --name ${state.name}; switch to ${name}? [y/N]`;
    if (v.yes || !/^y(es)?$/i.test(await deps.prompt(q)))
      throw new Error(
        `--name ${name} conflicts with saved --name ${state.name}; confirm interactively to switch`,
      );
  }
  const opts: Opts = {
    name,
    appHost: await need("--app-host", HOST, state.appHost),
    contentHost: await need("--content-host", HOST, state.contentHost),
    ownerEmail: await need("--owner-email", EMAIL, state.ownerEmail),
    accountId:
      v["account-id"] ?? state.accountId ?? deps.env.CLOUDFLARE_ACCOUNT_ID,
    yes: v.yes,
    upgrade: v.upgrade,
  };
  return opts;
}

/** Runs setup; resolves to the exit code (0 ok, 2 action_required, 1 error). */
export async function run(
  argv: string[],
  deps: Deps,
  root: string,
  steps: Step[] = STEPS,
): Promise<number> {
  const json = argv.includes("--json");
  const report = (l: Line) =>
    deps.out(
      json
        ? JSON.stringify(l)
        : `${ICON[l.status]} ${l.step}: ${l.message}${l.data ? ` ${JSON.stringify(l.data)}` : ""}`,
    );
  const fs = deps.fs ?? realFs;
  let opts: Opts;
  let state: State;
  try {
    state = readState(fs, root);
    opts = await resolve(argv, deps, state);
  } catch (e) {
    report({ step: "args", status: "error", message: (e as Error).message });
    return 1;
  }
  const { name, appHost, contentHost, ownerEmail } = opts;
  Object.assign(state, { name, appHost, contentHost, ownerEmail });
  const wrangler = makeWrangler(deps, root, () => state.accountId);
  const api = makeApi(deps, wrangler);
  const ctx: Ctx = { deps, fs, root, opts, wrangler, api };
  for (const step of steps) {
    try {
      if ((await step.check(state, ctx)) === "done") {
        report({ step: step.name, status: "skipped", message: "already done" });
        continue;
      }
      const r = await step.apply(state, ctx);
      if (r) {
        report({ step: step.name, ...r });
        return 2;
      }
      report({ step: step.name, status: "ok", message: "done" });
    } catch (e) {
      const message = (e as Error).message;
      report({ step: step.name, status: "error", message });
      return 1;
    } finally {
      writeState(fs, root, state);
    }
  }
  writeState(fs, root, state);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  process.exitCode = await run(process.argv.slice(2), realDeps(), root);
}
