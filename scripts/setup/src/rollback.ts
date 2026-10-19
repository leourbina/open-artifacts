import { parseArgs } from "node:util";
import { type Deps, makeWrangler, realFs } from "./cf.ts";
import { readState, writeState } from "./state.ts";

const PAT_RE = /oa_pat_[1-9A-HJ-NP-Za-km-z]+/g;

/** --rollback: wrangler rollback to the version the last deploy replaced; touches nothing else. */
export async function rollbackCommand(
  argv: string[],
  deps: Deps,
  root: string,
): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    strict: false,
    options: {
      name: { type: "string" },
      "account-id": { type: "string" },
      json: { type: "boolean" },
    },
  });
  const json = Boolean(v.json);
  const report = (
    status: "ok" | "action_required" | "error",
    step: string,
    message: string,
    data?: unknown,
  ) => {
    const secrets = [
      deps.env.CLOUDFLARE_API_TOKEN,
      deps.env.OA_ACCESS_TOKEN,
      deps.env.ANALYTICS_TOKEN,
    ].filter((s): s is string => Boolean(s));
    let safe = message.replace(PAT_RE, "[redacted]");
    for (const s of secrets) safe = safe.split(s).join("[redacted]");
    deps.out(
      json
        ? JSON.stringify({ step, status, message: safe, data })
        : `${{ ok: "✓", action_required: "!", error: "✗" }[status]} ${step}: ${safe}`,
    );
  };
  const clash = ["--upgrade", "--check", "--ci"].filter((f) =>
    argv.includes(f),
  );
  if (clash.length) {
    report(
      "error",
      "args",
      `--rollback runs on its own; drop ${clash.join(", ")}`,
    );
    return 1;
  }
  const fs = deps.fs ?? realFs;
  const state = readState(fs, root);
  const name = (v.name as string | undefined) ?? state.name ?? "open-artifacts";
  const to = state.previousWorkerVersion;
  if (!to) {
    report(
      "action_required",
      "rollback",
      `no previous version is recorded; roll back in the dashboard: Workers → ${name} → Deployments`,
    );
    return 2;
  }
  const accountId =
    (v["account-id"] as string | undefined) ??
    state.accountId ??
    deps.env.CLOUDFLARE_ACCOUNT_ID;
  const wrangler = makeWrangler(deps, root, () => accountId);
  try {
    await wrangler(["rollback", to, "--message", "oa:setup --rollback", "-y"]);
  } catch (e) {
    report("error", "rollback", (e as Error).message);
    return 1;
  }
  const from = state.workerVersion;
  state.workerVersion = to;
  state.previousWorkerVersion = from;
  writeState(fs, root, state);
  report("ok", "rollback", `rolled ${name} back to ${to}`, { from, to });
  return 0;
}
