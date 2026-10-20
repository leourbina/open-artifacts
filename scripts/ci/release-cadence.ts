// Release cadence: arm the release-please PR when it is green and the merge
// queue has drained, and keep one `blocker` issue open while a release is stuck.
// Usage: node --experimental-strip-types scripts/ci/release-cadence.ts <arm|blocker> --repo owner/name
// Needs GH_TOKEN in the environment. `arm` runs with the release App's token
// (so the merge triggers workflows); `blocker` runs with GITHUB_TOKEN.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const RELEASE_BRANCH =
  "release-please--branches--main--components--open-artifacts";
const BLOCKED = "Release blocked:";
const DAY_MS = 24 * 3600_000;

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
  cmd: string,
  args: string[],
) => ExecResult | Promise<ExecResult>;

const QUERY = `query($owner: String!, $name: String!, $head: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, headRefName: $head, first: 1) {
      nodes {
        number
        url
        title
        createdAt
        isInMergeQueue
        autoMergeRequest { enabledAt }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion status detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
    mergeQueue(branch: $branch) {
      entries(first: 100) {
        totalCount
        nodes { pullRequest { number headRefName } }
      }
    }
  }
}`;

type Context = {
  __typename?: string;
  name?: string;
  conclusion?: string;
  detailsUrl?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
};
export type ReleasePr = {
  number: number;
  url: string;
  title: string;
  createdAt: string;
  queued: boolean;
  armed: boolean;
  rollup: string;
  contexts: Context[];
};
type Snapshot = { pr?: ReleasePr; others: number };

async function gh(exec: Exec, args: string[]): Promise<string> {
  const r = await exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

async function snapshot(exec: Exec, repo: string): Promise<Snapshot> {
  const [owner, name] = repo.split("/");
  const out = await gh(exec, [
    "api",
    "graphql",
    "-f",
    `query=${QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    `head=${RELEASE_BRANCH}`,
    "-f",
    "branch=main",
  ]);
  const repository = JSON.parse(out)?.data?.repository;
  const n = repository?.pullRequests?.nodes?.[0];
  const entries: { pullRequest?: { headRefName?: string } }[] =
    repository?.mergeQueue?.entries?.nodes ?? [];
  const others = entries.filter(
    (e) =>
      !String(e.pullRequest?.headRefName ?? "").startsWith("release-please--"),
  ).length;
  if (!n) return { others };
  const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  return {
    others,
    pr: {
      number: n.number,
      url: n.url,
      title: n.title,
      createdAt: n.createdAt,
      queued: Boolean(n.isInMergeQueue),
      armed: Boolean(n.autoMergeRequest),
      rollup: rollup?.state ?? "NONE",
      contexts: rollup?.contexts?.nodes ?? [],
    },
  };
}

export type ArmResult =
  | { action: "none" }
  | { action: "already"; pr: number }
  | { action: "not-green"; pr: number; state: string }
  | { action: "waiting"; entries: number }
  | { action: "armed"; pr: number };

/** Arms auto-merge on the release PR once it is green and the queue holds nothing but release PRs. */
export async function arm(o: {
  exec: Exec;
  repo: string;
  log: (line: string) => void;
}): Promise<ArmResult> {
  const { pr, others } = await snapshot(o.exec, o.repo);
  if (!pr) {
    o.log("no open release PR");
    return { action: "none" };
  }
  if (pr.queued || pr.armed) {
    o.log(
      `release PR #${pr.number} is already ${pr.queued ? "queued" : "armed"}`,
    );
    return { action: "already", pr: pr.number };
  }
  if (pr.rollup !== "SUCCESS") {
    o.log(`release PR #${pr.number} checks are ${pr.rollup}, not arming`);
    return { action: "not-green", pr: pr.number, state: pr.rollup };
  }
  if (others > 0) {
    o.log(`waiting for the queue to drain (${others} entries)`);
    return { action: "waiting", entries: others };
  }
  await gh(o.exec, [
    "pr",
    "merge",
    String(pr.number),
    "--auto",
    "--squash",
    "--repo",
    o.repo,
  ]);
  o.log(`armed auto-merge on release PR #${pr.number}`);
  return { action: "armed", pr: pr.number };
}

const FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
function failing(contexts: Context[]): { name: string; url?: string }[] {
  const out: { name: string; url?: string }[] = [];
  for (const c of contexts) {
    if (c.__typename === "StatusContext") {
      if (c.state === "FAILURE" || c.state === "ERROR")
        out.push({ name: String(c.context), url: c.targetUrl });
    } else if (c.conclusion && FAILED.has(c.conclusion))
      out.push({ name: String(c.name), url: c.detailsUrl });
  }
  return out;
}

export type BlockerResult =
  | { action: "none" }
  | { action: "opened" }
  | { action: "refreshed"; issue: number }
  | { action: "closed"; issues: number[] };

/** Keeps one `blocker` issue in step with a stuck release PR, and closes it once the release shipped. */
export async function blocker(o: {
  exec: Exec;
  repo: string;
  now: () => number;
  log: (line: string) => void;
}): Promise<BlockerResult> {
  const { pr } = await snapshot(o.exec, o.repo);
  const issues: { number: number; title: string; createdAt: string }[] =
    JSON.parse(
      await gh(o.exec, [
        "issue",
        "list",
        "--repo",
        o.repo,
        "--label",
        "blocker",
        "--state",
        "open",
        "--json",
        "number,title,createdAt",
        "--limit",
        "50",
      ]),
    ).filter((i: { title: string }) => i.title.startsWith(BLOCKED));

  if (pr) {
    const bad = pr.rollup === "FAILURE" || pr.rollup === "ERROR";
    const old = o.now() - Date.parse(pr.createdAt) > DAY_MS;
    if (!bad && !old) return { action: "none" };
    const reasons = [
      ...(bad ? [`release PR #${pr.number} has failing checks`] : []),
      ...(old
        ? [`release PR #${pr.number} has been open for over 24 hours`]
        : []),
    ];
    const lines = [
      `${pr.title}: ${pr.url}`,
      "",
      ...reasons.map((r) => `- ${r}`),
      ...(bad
        ? [
            "",
            "Failing checks:",
            ...failing(pr.contexts).map((f) =>
              f.url ? `- [${f.name}](${f.url})` : `- ${f.name}`,
            ),
          ]
        : []),
      "",
      "This issue closes itself when the release ships.",
    ];
    const title = `${BLOCKED} ${reasons[0]}`;
    const body = lines.join("\n");
    const existing = issues[0];
    if (existing) {
      await gh(o.exec, [
        "issue",
        "edit",
        String(existing.number),
        "--repo",
        o.repo,
        "--title",
        title,
        "--body",
        body,
      ]);
      return { action: "refreshed", issue: existing.number };
    }
    await gh(o.exec, [
      "label",
      "create",
      "blocker",
      "--repo",
      o.repo,
      "--force",
      "--color",
      "B60205",
      "--description",
      "A release or deploy is stuck",
    ]);
    await gh(o.exec, [
      "issue",
      "create",
      "--repo",
      o.repo,
      "--title",
      title,
      "--body",
      body,
      "--label",
      "blocker",
    ]);
    return { action: "opened" };
  }

  if (!issues.length) return { action: "none" };
  const latest = await o.exec("gh", ["api", `repos/${o.repo}/releases/latest`]);
  if (latest.code !== 0) return { action: "none" };
  const rel: { tag_name?: string; published_at?: string } = JSON.parse(
    latest.stdout,
  );
  const shipped = Date.parse(rel.published_at ?? "");
  const closed: number[] = [];
  for (const i of issues) {
    if (!(shipped > Date.parse(i.createdAt))) continue;
    await gh(o.exec, [
      "issue",
      "close",
      String(i.number),
      "--repo",
      o.repo,
      "--comment",
      `Released ${rel.tag_name}; no release PR is open. Closing.`,
    ]);
    closed.push(i.number);
  }
  return closed.length
    ? { action: "closed", issues: closed }
    : { action: "none" };
}

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

async function main(argv: string[]) {
  const [mode, flag, repo] = argv;
  if ((mode !== "arm" && mode !== "blocker") || flag !== "--repo" || !repo) {
    console.error("usage: release-cadence.ts <arm|blocker> --repo owner/name");
    return 2;
  }
  const log = (s: string) => console.log(s);
  const r =
    mode === "arm"
      ? await arm({ exec: realExec, repo, log })
      : await blocker({ exec: realExec, repo, now: Date.now, log });
  console.log(JSON.stringify(r));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    },
  );
