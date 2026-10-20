import { describe, expect, it } from "vitest";
import { arm, blocker, type Exec, RELEASE_BRANCH } from "./release-cadence.ts";

const REPO = "open-artifacts-ai/open-artifacts";
const NOW = Date.parse("2026-10-21T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

type Ctx = {
  __typename: string;
  name?: string;
  conclusion?: string;
  detailsUrl?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
};
type Fixture = {
  pr?: {
    number?: number;
    createdAt?: string;
    state?: string;
    queued?: boolean;
    armed?: boolean;
    contexts?: Ctx[];
  };
  queue?: { headRefName: string; number: number }[] | null;
  issues?: { number: number; title: string; createdAt: string }[];
  release?: { tag_name: string; published_at: string } | null;
};

/** A fake `gh`: answers graphql and the REST/issue commands from the fixture and logs every call. */
function fake(f: Fixture) {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (cmd !== "gh") return { code: 127, stdout: "", stderr: "no" };
    if (args[0] === "api" && args[1] === "graphql") {
      const pr = f.pr
        ? [
            {
              number: f.pr.number ?? 301,
              url: `https://github.com/${REPO}/pull/${f.pr.number ?? 301}`,
              title: "chore(main): release 0.6.0",
              createdAt: f.pr.createdAt ?? hoursAgo(1),
              isInMergeQueue: f.pr.queued ?? false,
              autoMergeRequest: f.pr.armed ? { enabledAt: hoursAgo(0) } : null,
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: f.pr.state ?? "SUCCESS",
                        contexts: { nodes: f.pr.contexts ?? [] },
                      },
                    },
                  },
                ],
              },
            },
          ]
        : [];
      const queue =
        f.queue === null || f.queue === undefined
          ? f.queue === null
            ? null
            : { entries: { totalCount: 0, nodes: [] } }
          : {
              entries: {
                totalCount: f.queue.length,
                nodes: f.queue.map((e) => ({
                  pullRequest: { number: e.number, headRefName: e.headRefName },
                })),
              },
            };
      return ok(
        JSON.stringify({
          data: {
            repository: { pullRequests: { nodes: pr }, mergeQueue: queue },
          },
        }),
      );
    }
    if (args[0] === "issue" && args[1] === "list")
      return ok(JSON.stringify(f.issues ?? []));
    if (args[0] === "api" && String(args[1]).endsWith("/releases/latest"))
      return f.release
        ? ok(JSON.stringify(f.release))
        : { code: 1, stdout: "", stderr: "HTTP 404" };
    return ok("");
  };
  const wrote = (verb: string) =>
    calls.filter((c) => c[0] === "gh" && c.slice(1, 3).join(" ") === verb);
  return { exec, calls, wrote };
}
const logs = () => {
  const out: string[] = [];
  return { log: (s: string) => out.push(s), out };
};

describe("arm", () => {
  it("does nothing when there is no release PR", async () => {
    const g = fake({});
    const l = logs();
    expect(await arm({ exec: g.exec, repo: REPO, log: l.log })).toEqual({
      action: "none",
    });
    expect(g.wrote("pr merge")).toEqual([]);
  });

  it("looks the release PR up by its head branch", async () => {
    const g = fake({ pr: {} });
    await arm({ exec: g.exec, repo: REPO, log: logs().log });
    const q = g.calls.find((c) => c.includes("graphql")) ?? [];
    expect(q.join(" ")).toContain(`head=${RELEASE_BRANCH}`);
    expect(q.join(" ")).toContain("mergeQueue(branch:");
    expect(q.join(" ")).toContain("branch=main");
  });

  it("arms auto-merge when the rollup is SUCCESS and the queue is empty", async () => {
    const g = fake({ pr: { number: 301, state: "SUCCESS" } });
    expect(await arm({ exec: g.exec, repo: REPO, log: logs().log })).toEqual({
      action: "armed",
      pr: 301,
    });
    expect(g.wrote("pr merge")).toEqual([
      ["gh", "pr", "merge", "301", "--auto", "--squash", "--repo", REPO],
    ]);
  });

  it("arms when the queue only holds release PRs", async () => {
    const g = fake({
      pr: {},
      queue: [{ number: 299, headRefName: RELEASE_BRANCH }],
    });
    expect(
      (await arm({ exec: g.exec, repo: REPO, log: logs().log })).action,
    ).toBe("armed");
  });

  it("does not arm while the queue has other entries, and says how many", async () => {
    const g = fake({
      pr: {},
      queue: [
        { number: 11, headRefName: "feat/a" },
        { number: 12, headRefName: "fix/b" },
        { number: 299, headRefName: RELEASE_BRANCH },
      ],
    });
    const l = logs();
    expect(await arm({ exec: g.exec, repo: REPO, log: l.log })).toEqual({
      action: "waiting",
      entries: 2,
    });
    expect(l.out).toContain("waiting for the queue to drain (2 entries)");
    expect(g.wrote("pr merge")).toEqual([]);
  });

  it("uses the same wording for any count", async () => {
    const g = fake({ pr: {}, queue: [{ number: 11, headRefName: "feat/a" }] });
    const l = logs();
    await arm({ exec: g.exec, repo: REPO, log: l.log });
    expect(l.out).toContain("waiting for the queue to drain (1 entries)");
  });

  it("does not arm a PR whose rollup is not SUCCESS", async () => {
    for (const state of ["PENDING", "FAILURE", "ERROR", "EXPECTED"]) {
      const g = fake({ pr: { state } });
      const l = logs();
      expect((await arm({ exec: g.exec, repo: REPO, log: l.log })).action).toBe(
        "not-green",
      );
      expect(l.out.join("\n")).toContain(state);
      expect(g.wrote("pr merge")).toEqual([]);
    }
  });

  it("does nothing when the PR is already armed or already in the queue", async () => {
    for (const pr of [{ armed: true }, { queued: true }]) {
      const g = fake({ pr });
      expect(
        (await arm({ exec: g.exec, repo: REPO, log: logs().log })).action,
      ).toBe("already");
      expect(g.wrote("pr merge")).toEqual([]);
    }
  });

  it("a queue that doesn't exist (null) counts as empty", async () => {
    const g = fake({ pr: {}, queue: null });
    expect(
      (await arm({ exec: g.exec, repo: REPO, log: logs().log })).action,
    ).toBe("armed");
  });

  it("a failing gh pr merge is an error, not a silent pass", async () => {
    const g = fake({ pr: {} });
    const exec: Exec = (cmd, args) =>
      args[0] === "pr"
        ? { code: 1, stdout: "", stderr: "not allowed" }
        : g.exec(cmd, args);
    await expect(arm({ exec, repo: REPO, log: logs().log })).rejects.toThrow(
      /not allowed/,
    );
  });

  it("a graphql failure is an error", async () => {
    const exec: Exec = () => ({ code: 1, stdout: "", stderr: "bad token" });
    await expect(arm({ exec, repo: REPO, log: logs().log })).rejects.toThrow(
      /bad token/,
    );
  });
});

describe("blocker", () => {
  const run = (f: Fixture) => {
    const g = fake(f);
    const l = logs();
    return blocker({
      exec: g.exec,
      repo: REPO,
      now: () => NOW,
      log: l.log,
    }).then((r) => ({ r, g, l }));
  };
  const body = (c: string[]) => c[c.indexOf("--body") + 1] as string;
  const title = (c: string[]) => c[c.indexOf("--title") + 1] as string;

  it("opens one blocker issue naming the failing checks with links when the rollup is FAILURE", async () => {
    const { r, g } = await run({
      pr: {
        state: "FAILURE",
        contexts: [
          {
            __typename: "CheckRun",
            name: "test",
            conclusion: "FAILURE",
            detailsUrl: "https://ci/test",
          },
          {
            __typename: "CheckRun",
            name: "lint",
            conclusion: "SUCCESS",
            detailsUrl: "https://ci/lint",
          },
          {
            __typename: "StatusContext",
            context: "legacy",
            state: "ERROR",
            targetUrl: "https://ci/legacy",
          },
        ],
      },
    });
    expect(r).toEqual({ action: "opened" });
    const [create] = g.wrote("issue create");
    expect(create).toBeDefined();
    expect(title(create as string[])).toMatch(/^Release blocked: /);
    expect(title(create as string[])).toContain("failing checks");
    expect(create).toContain("--label");
    expect(create?.[create.indexOf("--label") + 1]).toBe("blocker");
    const b = body(create as string[]);
    expect(b).toContain("[test](https://ci/test)");
    expect(b).toContain("[legacy](https://ci/legacy)");
    expect(b).not.toContain("lint");
    expect(g.wrote("label create").length).toBe(1);
  });

  it("opens an issue when the PR is older than 24 hours, even if the checks pass", async () => {
    const { r, g } = await run({ pr: { createdAt: hoursAgo(25) } });
    expect(r.action).toBe("opened");
    expect(title(g.wrote("issue create")[0] as string[])).toContain("24 hours");
  });

  it("opens nothing for a young, green PR", async () => {
    const { r, g } = await run({ pr: { createdAt: hoursAgo(23) } });
    expect(r.action).toBe("none");
    expect(g.wrote("issue create")).toEqual([]);
  });

  it("refreshes the existing issue (found by label and title prefix) instead of opening a second", async () => {
    const { r, g } = await run({
      pr: {
        state: "FAILURE",
        contexts: [
          {
            __typename: "CheckRun",
            name: "e2e",
            conclusion: "FAILURE",
            detailsUrl: "https://ci/e2e",
          },
        ],
      },
      issues: [
        {
          number: 7,
          title: "Release blocked: release PR #301 is over 24 hours old",
          createdAt: hoursAgo(30),
        },
        {
          number: 8,
          title: "Release v0.5.0 not live: healthz",
          createdAt: hoursAgo(5),
        },
      ],
    });
    expect(r).toEqual({ action: "refreshed", issue: 7 });
    expect(g.wrote("issue create")).toEqual([]);
    const [edit] = g.wrote("issue edit");
    expect(edit?.[3]).toBe("7");
    expect(body(edit as string[])).toContain("[e2e](https://ci/e2e)");
  });

  it("looks issues up by the blocker label", async () => {
    const { g } = await run({ pr: { state: "FAILURE" } });
    const list = g.wrote("issue list")[0] ?? [];
    expect(list).toContain("--label");
    expect(list[list.indexOf("--label") + 1]).toBe("blocker");
  });

  it("closes the issue with a comment when no release PR is open and a newer release shipped", async () => {
    const { r, g } = await run({
      issues: [
        {
          number: 7,
          title: "Release blocked: checks failing",
          createdAt: hoursAgo(30),
        },
      ],
      release: { tag_name: "v0.6.0", published_at: hoursAgo(2) },
    });
    expect(r).toEqual({ action: "closed", issues: [7] });
    const [close] = g.wrote("issue close");
    expect(close?.[3]).toBe("7");
    expect(close?.[close.indexOf("--comment") + 1]).toContain("v0.6.0");
  });

  it("keeps the issue open when the latest release is older than the issue", async () => {
    const { r, g } = await run({
      issues: [
        { number: 7, title: "Release blocked: x", createdAt: hoursAgo(3) },
      ],
      release: { tag_name: "v0.5.0", published_at: hoursAgo(50) },
    });
    expect(r.action).toBe("none");
    expect(g.wrote("issue close")).toEqual([]);
  });

  it("keeps the issue open while a release PR is still open", async () => {
    const { g } = await run({
      pr: { createdAt: hoursAgo(1) },
      issues: [
        { number: 7, title: "Release blocked: x", createdAt: hoursAgo(30) },
      ],
      release: { tag_name: "v0.6.0", published_at: hoursAgo(2) },
    });
    expect(g.wrote("issue close")).toEqual([]);
  });

  it("never touches issues whose title lacks the prefix", async () => {
    const { g } = await run({
      issues: [
        {
          number: 9,
          title: "Release v0.5.0 not live: healthz",
          createdAt: hoursAgo(30),
        },
      ],
      release: { tag_name: "v0.6.0", published_at: hoursAgo(2) },
    });
    expect(g.wrote("issue close")).toEqual([]);
  });

  it("no release at all (404) leaves issues alone", async () => {
    const { r } = await run({
      issues: [
        { number: 7, title: "Release blocked: x", createdAt: hoursAgo(30) },
      ],
      release: null,
    });
    expect(r.action).toBe("none");
  });
});
