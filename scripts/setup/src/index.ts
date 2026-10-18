import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type Deps, makeApi, makeWrangler, realDeps, realFs } from "./cf.ts";
import { readState, type State, writeState } from "./state.ts";
import type { Ctx, Opts, Step } from "./step.ts";
import { access } from "./steps/access.ts";
import { agentConfig } from "./steps/agent-config.ts";
import { deploy } from "./steps/deploy.ts";
import { ownerToken } from "./steps/owner-token.ts";
import { prereqs } from "./steps/prereqs.ts";
import { resources } from "./steps/resources.ts";
import { secrets } from "./steps/secrets.ts";
import { selftest } from "./steps/selftest.ts";

export const STEPS: Step[] = [
  prereqs,
  resources,
  access,
  secrets,
  deploy,
  ownerToken,
  selftest,
  agentConfig,
];

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

// apps/server/src/db/email.ts: printable ASCII, checked before and after lowercasing.
const ASCII_EMAIL = /^[!-?A-~]+@[!-?A-~]+$/;
function normEmail(raw: string) {
  const e = raw.trim().toLowerCase();
  if (![raw.trim(), e].every((x) => x.length <= 320 && ASCII_EMAIL.test(x)))
    throw new Error(`invalid --owner-email: ${JSON.stringify(raw)}`);
  return e;
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
      "new-owner-token": { type: "boolean", default: false },
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
    ownerEmail: valid(
      "--owner-email",
      normEmail(await need("--owner-email", /./, state.ownerEmail)),
      EMAIL,
    ),
    accountId:
      v["account-id"] ?? state.accountId ?? deps.env.CLOUDFLARE_ACCOUNT_ID,
    yes: v.yes,
    upgrade: v.upgrade,
    newOwnerToken: v["new-owner-token"],
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
  let human: string | undefined;
  const report = (l: Line) => {
    const extra = human
      ? `\n${human}`
      : l.data
        ? ` ${JSON.stringify(l.data)}`
        : "";
    deps.out(
      json
        ? JSON.stringify(l)
        : `${ICON[l.status]} ${l.step}: ${l.message}${extra}`,
    );
  };
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
  const accessApi = makeApi(deps, wrangler, deps.env.OA_ACCESS_TOKEN);
  const ctx: Ctx = {
    deps,
    fs,
    root,
    opts,
    wrangler,
    api,
    accessApi,
    notes: [],
  };
  const msg = (fallback: string) => ctx.notes.splice(0).join("; ") || fallback;
  /** Moves the step's data (and human text) out of ctx onto its line. */
  const take = (status: "ok" | "skipped", fallback: string): Line => {
    const { data } = ctx;
    human = ctx.human;
    ctx.data = ctx.human = undefined;
    const l: Line = { step: "", status, message: msg(fallback) };
    return data === undefined ? l : { ...l, data };
  };
  for (const step of steps) {
    human = ctx.data = ctx.human = undefined;
    try {
      if ((await step.check(state, ctx)) === "done") {
        report({ ...take("skipped", "already done"), step: step.name });
        continue;
      }
      const r = await step.apply(state, ctx);
      if (r) {
        ctx.notes.length = 0;
        report({ step: step.name, ...r });
        return 2;
      }
      report({ ...take("ok", "done"), step: step.name });
    } catch (e) {
      ctx.notes.length = 0;
      const message = (e as Error).message;
      report({ step: step.name, status: "error", message });
      return (e as { exitCode?: number }).exitCode ?? 1;
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
