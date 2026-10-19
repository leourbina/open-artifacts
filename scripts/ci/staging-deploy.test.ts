import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requiredSecrets } from "../ops/check-staging-secrets.ts";
import { root, sandbox, script, write } from "./stubs.ts";

const wrangler = readFileSync(
  join(root, "apps/server/wrangler.staging.jsonc"),
  "utf8",
);
const required = requiredSecrets(
  readFileSync(join(root, "apps/server/src/env.ts"), "utf8"),
  wrangler,
);
const vars = Object.keys(
  JSON.parse(
    wrangler.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
  ).env.staging.vars,
);
const list = (names: string[]) =>
  JSON.stringify(names.map((name) => ({ name, type: "secret_text" })));
// pnpm stub: `wrangler secret list` prints $SECRETS_JSON; everything else just logs.
const pnpm = '[[ "$*" == *"secret list"* ]] && printf %s "$SECRETS_JSON"; true';

describe("staging-preflight.sh", () => {
  it("passes when all required secrets exist", () => {
    const sb = sandbox({ pnpm });
    const r = sb.run(["bash", script("staging-preflight.sh")], {
      env: { SECRETS_JSON: list(required) },
    });
    expect(r.code).toBe(0);
    expect(sb.log()).toEqual([
      "pnpm exec wrangler secret list -c wrangler.staging.jsonc --env staging --format json",
    ]);
  });
  it("fails and names a missing secret", () => {
    const sb = sandbox({ pnpm });
    const r = sb.run(["bash", script("staging-preflight.sh")], {
      env: { SECRETS_JSON: list(required.slice(1)) },
    });
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain(required[0]);
  });
});

describe("staging-clear-conflicts.sh", () => {
  const conflict = vars[0] as string;
  it("deletes only secrets that are also vars", () => {
    const sb = sandbox({ pnpm });
    const r = sb.run(["bash", script("staging-clear-conflicts.sh")], {
      env: { SECRETS_JSON: list([conflict, "NOT_A_VAR_SECRET"]) },
    });
    expect(r.code).toBe(0);
    const deletes = sb.log().filter((l) => l.includes("secret delete"));
    expect(deletes).toEqual([
      `pnpm exec wrangler secret delete ${conflict} -c wrangler.staging.jsonc --env staging`,
    ]);
  });
  it("deletes nothing when there is no conflict", () => {
    const sb = sandbox({ pnpm });
    const r = sb.run(["bash", script("staging-clear-conflicts.sh")], {
      env: { SECRETS_JSON: list(["NOT_A_VAR_SECRET"]) },
    });
    expect(r.code).toBe(0);
    expect(sb.log().some((l) => l.includes("secret delete"))).toBe(false);
  });
});

describe("ensure-dashboard-dist.sh", () => {
  it("writes a placeholder when the build produced no index.html", () => {
    const sb = sandbox({});
    const dist = join(sb.dir, "dist");
    const r = sb.run(["bash", script("ensure-dashboard-dist.sh")], {
      env: { DASHBOARD_DIST: dist },
    });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain("<title>");
  });
  it("keeps an existing index.html", () => {
    const sb = sandbox({});
    const dist = join(sb.dir, "dist");
    write(join(dist, "index.html"), "real");
    sb.run(["bash", script("ensure-dashboard-dist.sh")], {
      env: { DASHBOARD_DIST: dist },
    });
    expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("real");
  });
});

describe("staging-analytics-token.sh", () => {
  const secret = "analytics-SECRET-value";
  // pnpm stub: record stdin so the test sees what `secret put` received.
  const pnpm = 'cat > "$STUB_LOG.stdin"';
  it("puts ANALYTICS_TOKEN on the staging Worker via stdin, never argv or output", () => {
    const sb = sandbox({ pnpm });
    const r = sb.run(["bash", script("staging-analytics-token.sh")], {
      env: { ANALYTICS_TOKEN: secret },
    });
    expect(r.code).toBe(0);
    expect(sb.log()).toEqual([
      "pnpm exec wrangler secret put ANALYTICS_TOKEN -c wrangler.staging.jsonc --env staging",
    ]);
    expect(readFileSync(join(sb.dir, "calls.log.stdin"), "utf8")).toBe(secret);
    expect(r.out + r.err).not.toContain(secret);
  });
  it("skips cleanly when the secret is empty", () => {
    const sb = sandbox({ pnpm });
    const r = sb.run(["bash", script("staging-analytics-token.sh")], {
      env: { ANALYTICS_TOKEN: "" },
    });
    expect(r.code).toBe(0);
    expect(sb.log()).toEqual([]);
    expect(r.out).toContain("skipping");
  });
  it("a failed put reports failed (annotation + output) and exits 0 so smoke runs", () => {
    const sb = sandbox({ pnpm: "cat >/dev/null; exit 1" });
    const out = join(sb.dir, "gh-output");
    const r = sb.run(["bash", script("staging-analytics-token.sh")], {
      env: { ANALYTICS_TOKEN: secret, GITHUB_OUTPUT: out },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("::error::");
    expect(readFileSync(out, "utf8")).toBe("analytics=failed\n");
    expect(r.out + r.err).not.toContain(secret);
  });
  it("records ok and skipped outcomes", () => {
    for (const [env, want] of [
      [{ ANALYTICS_TOKEN: secret }, "ok"],
      [{ ANALYTICS_TOKEN: "" }, "skipped"],
    ] as const) {
      const sb = sandbox({ pnpm });
      const out = join(sb.dir, "gh-output");
      sb.run(["bash", script("staging-analytics-token.sh")], {
        env: { ...env, GITHUB_OUTPUT: out },
      });
      expect(readFileSync(out, "utf8")).toBe(`analytics=${want}\n`);
    }
  });
  it("outcome mode fails only on failed", () => {
    for (const [v, code] of [
      ["failed", 1],
      ["ok", 0],
      ["skipped", 0],
      ["", 0],
    ] as const) {
      const sb = sandbox({});
      const r = sb.run(
        ["bash", script("staging-analytics-token.sh"), "outcome"],
        {
          env: { ANALYTICS_OUTCOME: v },
        },
      );
      expect(r.code, v).toBe(code);
    }
  });
});
