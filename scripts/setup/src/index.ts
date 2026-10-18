import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type Deps, makeApi, makeWrangler, realDeps, realFs } from "./cf.ts";
import { readOnlyDeps } from "./readonly.ts";
import { readState, type State, statePath, writeState } from "./state.ts";
import { type Ctx, NeedInput, type Opts, type Step } from "./step.ts";
import { access } from "./steps/access.ts";
import { agentConfig } from "./steps/agent-config.ts";
import { deploy } from "./steps/deploy.ts";
import { ownerToken, revokeToken } from "./steps/owner-token.ts";
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
  /** `done`/`todo` only under --check. */
  status: "ok" | "skipped" | "action_required" | "error" | "done" | "todo";
  message: string;
  data?: unknown;
};
const ICON = {
  ok: "✓",
  skipped: "·",
  action_required: "!",
  error: "✗",
  done: "✓",
  todo: "○",
};

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
      check: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      "new-owner-token": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      ci: { type: "boolean", default: false },
    },
  });
  const json = v.json || v.ci;
  const interactive = !v.yes && !json;
  // Precedence: flag, then saved state, then an interactive prompt.
  const need = async (flag: string, re: RegExp, saved?: string) => {
    const q = `${flag.slice(2).replace("-", " ")}:`;
    const val =
      (v[flag.slice(2) as keyof typeof v] as string | undefined) ??
      saved ??
      (interactive ? await deps.prompt(q) : undefined);
    if (val) return valid(flag, val, re);
    if (json) throw new NeedInput(`pass ${flag} (--json never prompts)`);
    throw new Error(`missing ${flag} (required with --yes)`);
  };
  if (v.ci && !v.name) throw new Error("--ci requires --name");
  if (v.ci && v["new-owner-token"])
    throw new Error(
      "--ci mints and revokes its own token; drop --new-owner-token",
    );
  if (v.strict && !v.check) throw new Error("--strict needs --check");
  // Without state, the name is what everything is found by: never guess it.
  if (!v.name && !state.name && (v.upgrade || v.check || v.yes || v.json))
    throw new NeedInput(
      "pass --name (no saved state; with --upgrade, --check, --yes or --json the install name is never defaulted)",
    );
  const name = valid("--name", v.name ?? state.name ?? "open-artifacts", NAME);
  if (state.name && name !== state.name) {
    const q = `State is for --name ${state.name}; switch to ${name}? [y/N]`;
    if (json)
      throw new NeedInput(
        `--name ${name} conflicts with saved --name ${state.name}; pass --name ${state.name}, or rerun interactively to switch`,
      );
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
    yes: v.yes || v.ci,
    upgrade: v.upgrade,
    check: v.check,
    strict: v.strict,
    newOwnerToken: v["new-owner-token"],
    interactive,
    json,
    ci: v.ci,
  };
  return opts;
}

/** State fields --check reports: ids and hosts, never secrets. */
const REPORTED = [
  "name",
  "accountId",
  "appHost",
  "contentHost",
  "ownerEmail",
  "d1Id",
  "r2Bucket",
  "kvId",
  "accessAppId",
  "accessClientId",
  "teamDomain",
  "ownerTokenId",
] as const;

/** --check: every step's check(), never apply; the rebuilt state goes in the last line. */
async function checkOnly(
  steps: Step[],
  state: State,
  ctx: Ctx,
  report: (l: Line) => void,
): Promise<number> {
  let todo = false;
  for (const step of steps) {
    ctx.data = ctx.human = undefined;
    ctx.mustRun = false;
    try {
      const r = await step.check(state, ctx);
      if (r === "todo" && (!step.always || ctx.mustRun)) todo = true;
      const notes = ctx.notes.splice(0).join("; ");
      report({
        step: step.name,
        status: r,
        message: notes ? `${r}: ${notes}` : r,
      });
    } catch (e) {
      ctx.notes.length = 0;
      const message = (e as Error).message;
      const ar = e instanceof NeedInput;
      report({
        step: step.name,
        status: ar ? "action_required" : "error",
        message,
      });
      return ar ? 2 : 1;
    }
  }
  ctx.data = ctx.human = undefined;
  const data = Object.fromEntries(
    REPORTED.filter((k) => state[k] !== undefined).map((k) => [k, state[k]]),
  );
  report({
    step: "state",
    status: "ok",
    message: "rebuilt from Cloudflare (not written)",
    data,
  });
  return ctx.opts.strict && todo ? 2 : 0;
}

/** Runs setup; resolves to the exit code (0 ok, 2 action_required, 1 error). */
export async function run(
  argv: string[],
  deps: Deps,
  root: string,
  steps: Step[] = STEPS,
): Promise<number> {
  const json = argv.includes("--json") || argv.includes("--ci");
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
  const rawFs = deps.fs ?? realFs;
  let fs = rawFs;
  let opts: Opts;
  let state: State;
  try {
    state = readState(fs, root);
    opts = await resolve(argv, deps, state);
  } catch (e) {
    const ar = e instanceof NeedInput;
    const status = ar ? "action_required" : "error";
    report({ step: "args", status, message: (e as Error).message });
    return ar ? 2 : 1;
  }
  // --ci never writes state.json (an ephemeral runner; ownerTokenId is meaningless once revoked).
  if (opts.ci)
    fs = {
      read: rawFs.read,
      write: (p, d) => {
        if (p !== statePath(root)) rawFs.write(p, d);
      },
    };
  const { name, appHost, contentHost, ownerEmail } = opts;
  const prev = {
    name: state.name,
    appHost: state.appHost,
    accountId: state.accountId,
  };
  Object.assign(state, { name, appHost, contentHost, ownerEmail });
  const noState = !prev.name;
  // --check: fetch is GET-only and exec runs only read-only wrangler, for every client.
  if (opts.check) deps = readOnlyDeps(deps);
  const wrangler = makeWrangler(deps, root, () => state.accountId);
  const api = makeApi(deps, wrangler);
  const accessApi = makeApi(deps, wrangler, deps.env.OA_ACCESS_TOKEN);
  const ctx: Ctx = {
    deps,
    noState,
    // --check writes nothing: no state, no rendered config.
    fs: opts.check ? { read: fs.read, write: () => {} } : fs,
    root,
    opts,
    wrangler,
    api,
    accessApi,
    notes: [],
    prev,
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
  if (opts.check) return checkOnly(steps, state, ctx, report);
  const runSteps = async (): Promise<number> => {
    for (const step of steps) {
      human = ctx.data = ctx.human = undefined;
      try {
        if ((await step.check(state, ctx)) === "done") {
          report({ ...take("skipped", "already done"), step: step.name });
          continue;
        }
        // Check-time notes explain the todo; apply reports its own.
        ctx.notes.length = 0;
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
        if (e instanceof NeedInput) {
          report({ step: step.name, status: "action_required", message });
          return 2;
        }
        report({ step: step.name, status: "error", message });
        return (e as { exitCode?: number }).exitCode ?? 1;
      } finally {
        writeState(fs, root, state);
      }
    }
    writeState(fs, root, state);
    return 0;
  };
  let code = 1;
  let revokeFailed = false;
  try {
    code = await runSteps();
  } finally {
    if (opts.ci && ctx.ciTokenId) {
      const id = ctx.ciTokenId;
      ctx.pat = ctx.ciTokenId = state.ownerTokenId = undefined;
      human = undefined;
      try {
        await revokeToken(ctx, id);
        report({
          step: "revoke-ci-token",
          status: "ok",
          message: `revoked CI owner token ${id}`,
        });
      } catch {
        report({
          step: "revoke-ci-token",
          status: "error",
          message: `could not revoke CI owner token ${id}; action_required: revoke it in Settings → Tokens`,
          data: { tokenId: id },
        });
        revokeFailed = true;
      }
    }
  }
  return revokeFailed && code === 0 ? 2 : code;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  process.exitCode = await run(process.argv.slice(2), realDeps(), root);
}
