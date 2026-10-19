import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script, write } from "./stubs.ts";

const pnpm = 'echo "PW_DIR=$PLAYWRIGHT_HTML_OUTPUT_DIR" >> "$STUB_LOG"';
const run = (arg: string, env: Record<string, string> = {}) => {
  const sb = sandbox({ pnpm, sudo: '"$@"' });
  return { ...sb.run(["bash", script("e2e.sh"), arg], { env }), sb };
};

describe("e2e.sh", () => {
  it("version writes the dashboard's Playwright version", () => {
    const sb = sandbox({});
    const out = join(sb.dir, "out");
    write(out, "");
    const r = sb.run(["bash", script("e2e.sh"), "version"], {
      env: { GITHUB_OUTPUT: out },
    });
    expect(r.code).toBe(0);
    const pkg = JSON.parse(
      readFileSync(
        join(root, "apps/dashboard/node_modules/@playwright/test/package.json"),
        "utf8",
      ),
    );
    expect(readFileSync(out, "utf8")).toBe(`playwright=${pkg.version}\n`);
  });
  it("install pins chromium and webkit with OS deps", () => {
    const r = run("install");
    expect(r.code).toBe(0);
    expect(r.sb.log()).toContain(
      "pnpm --filter @oa/dashboard exec playwright install --with-deps chromium webkit",
    );
  });
  it("hosts adds the line once", () => {
    const sb = sandbox({ sudo: '"$@"' });
    const hosts = join(sb.dir, "hosts");
    write(hosts, "127.0.0.1 localhost\n");
    for (let i = 0; i < 2; i++)
      expect(
        sb.run(["bash", script("e2e.sh"), "hosts"], {
          env: { HOSTS_FILE: hosts },
        }).code,
      ).toBe(0);
    expect(readFileSync(hosts, "utf8")).toBe(
      "127.0.0.1 localhost\n127.0.0.1 app.localhost content.localhost\n",
    );
  });
  it("mock and real run their suites into separate reports", () => {
    const mock = run("mock");
    expect(mock.code).toBe(0);
    expect(mock.sb.log()).toEqual([
      "pnpm --filter @oa/dashboard exec playwright test --reporter=list,html",
      "PW_DIR=playwright-report/mock",
    ]);
    const real = run("real");
    expect(real.code).toBe(0);
    expect(real.sb.log()).toEqual([
      "pnpm --filter @oa/dashboard exec playwright test -c playwright.real.config.ts",
      "PW_DIR=playwright-report/real",
    ]);
  });
  it("ui runs the @oa/ui real-browser checks (axe contrast, focus)", () => {
    const r = run("ui");
    expect(r.code).toBe(0);
    expect(r.sb.log()).toEqual([
      "pnpm --filter @oa/ui test:browser",
      "PW_DIR=",
    ]);
  });
  it("rejects an unknown step", () => {
    expect(run("deploy").code).toBe(2);
  });
});
