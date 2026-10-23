import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox } from "../ci/stubs.ts";

// T3b R-N2: the key ceremony uploads an env's signing key only when its
// GitHub Environment allows deployments from main only (the real control
// against a dispatch from another ref) and has a required reviewer.
const SCRIPT = join(root, "scripts/ops/hosted-set-signing-key.sh");
const KEY =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIfake0000000000000000000000000000000000\n-----END PRIVATE KEY-----\n";

// gh stub: answers the two environment reads from $ENV_JSON / $POL_JSON; a
// `secret set` stores its stdin in $SECRET_OUT.
const gh = `
case "$*" in
  "repo view --json nameWithOwner -q .nameWithOwner") echo "o/r";;
  "api repos/o/r/environments/"*"/deployment-branch-policies") printf '%s' "$POL_JSON";;
  "api repos/o/r/environments/"*) printf '%s' "$ENV_JSON";;
  "secret set RELEASE_SIGNING_KEY "*) cat > "$SECRET_OUT";;
  *) echo "unexpected gh $*" >&2; exit 9;;
esac`;

const GOOD_ENV = JSON.stringify({
  name: "hosted-staging",
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
  protection_rules: [
    { type: "required_reviewers", reviewers: [{ type: "User" }] },
    { type: "branch_policy" },
  ],
});
const GOOD_POL = JSON.stringify({
  total_count: 1,
  branch_policies: [{ name: "main", type: "branch" }],
});

function run(
  o: { env?: string; envJson?: string; polJson?: string; input?: string } = {},
) {
  const sb = sandbox({ gh });
  const out = join(sb.dir, "secret");
  const r = spawnSync("bash", [SCRIPT, o.env ?? "staging"], {
    input: o.input ?? KEY,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(sb.dir, "bin")}:${process.env.PATH}`,
      STUB_LOG: join(sb.dir, "calls.log"),
      ENV_JSON: o.envJson ?? GOOD_ENV,
      POL_JSON: o.polJson ?? GOOD_POL,
      SECRET_OUT: out,
    },
  });
  const calls = sb.log();
  const secret = (() => {
    try {
      return readFileSync(out, "utf8");
    } catch {
      return null;
    }
  })();
  return { code: r.status, out: r.stdout, err: r.stderr, calls, secret };
}

describe("hosted-set-signing-key.sh", () => {
  it("uploads the key from stdin when hosted-<env> allows main only, with a required reviewer", () => {
    const r = run();
    expect(r.code, r.err).toBe(0);
    expect(r.calls).toContain("gh api repos/o/r/environments/hosted-staging");
    expect(r.calls).toContain(
      "gh api repos/o/r/environments/hosted-staging/deployment-branch-policies",
    );
    expect(r.calls).toContain(
      "gh secret set RELEASE_SIGNING_KEY --env hosted-staging --repo o/r",
    );
    expect(r.secret).toBe(KEY);
    // The key reaches gh on stdin only: never in an argv or the output.
    expect(r.calls.join("\n")).not.toContain("PRIVATE KEY");
    expect(r.out + r.err).not.toContain("PRIVATE KEY");
  });

  it("checks the prod environment for prod", () => {
    const r = run({ env: "prod" });
    expect(r.code, r.err).toBe(0);
    expect(r.calls).toContain(
      "gh secret set RELEASE_SIGNING_KEY --env hosted-prod --repo o/r",
    );
  });

  const env = (
    p: unknown,
    rules: unknown[] = JSON.parse(GOOD_ENV).protection_rules,
  ) => JSON.stringify({ deployment_branch_policy: p, protection_rules: rules });
  it.each<[string, { envJson?: string; polJson?: string }]>([
    [
      "no deployment branch policy (every branch may deploy)",
      { envJson: env(null) },
    ],
    [
      "protected branches instead of a main-only list",
      {
        envJson: env({
          protected_branches: true,
          custom_branch_policies: false,
        }),
      },
    ],
    [
      "main plus another branch",
      {
        polJson: JSON.stringify({
          total_count: 2,
          branch_policies: [
            { name: "main", type: "branch" },
            { name: "dev", type: "branch" },
          ],
        }),
      },
    ],
    [
      "a wildcard branch pattern",
      {
        polJson: JSON.stringify({
          total_count: 1,
          branch_policies: [{ name: "*", type: "branch" }],
        }),
      },
    ],
    [
      "a tag named main",
      {
        polJson: JSON.stringify({
          total_count: 1,
          branch_policies: [{ name: "main", type: "tag" }],
        }),
      },
    ],
    [
      "no policies at all",
      { polJson: JSON.stringify({ total_count: 0, branch_policies: [] }) },
    ],
    [
      "no required reviewer",
      {
        envJson: env(
          { protected_branches: false, custom_branch_policies: true },
          [{ type: "branch_policy" }],
        ),
      },
    ],
    ["an environment read that is not JSON", { envJson: "not json" }],
  ])("refuses the key upload with %s", (_n, o) => {
    const r = run(o);
    expect(r.code).not.toBe(0);
    expect(r.calls.some((c) => c.startsWith("gh secret set"))).toBe(false);
    expect(r.secret).toBeNull();
    expect(r.err).toMatch(/refusing/);
  });

  it("refuses an unknown env and an empty stdin before any call", () => {
    for (const o of [{ env: "dev" }, { input: "" }]) {
      const r = run(o);
      expect(r.code).not.toBe(0);
      expect(r.calls).toEqual([]);
    }
  });

  it("docs/ops/hosted.md's key-ceremony checklist uses it and names main only", () => {
    const doc = readFileSync(join(root, "docs/ops/hosted.md"), "utf8");
    const at = doc.indexOf("### Key-ceremony checklist");
    expect(at).toBeGreaterThan(-1);
    const section = doc.slice(at, doc.indexOf("\n### ", at + 4));
    expect(section).toContain("main");
    expect(section).toMatch(/deployment branch/i);
    expect(section).toContain("scripts/ops/hosted-set-signing-key.sh");
    expect(section).toContain("gh api repos/{repo}/environments/");
  });
});
