import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "scripts/ci/release-only.ts");

const PKG = (extra: Record<string, unknown> = {}, version = "0.4.0") =>
  `${JSON.stringify(
    {
      name: "x",
      version,
      scripts: { test: "vitest" },
      dependencies: { a: "1.0.0" },
      engines: { node: ">=22" },
      ...extra,
    },
    null,
    2,
  )}\n`;

/** A throwaway git repo seeded with the files a release PR touches. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ro-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (path: string, data: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  };
  const commit = (msg = "c") => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  write("package.json", PKG());
  write("apps/server/package.json", PKG({}, "0.4.0"));
  write(".release-please-manifest.json", '{".":"0.4.0"}\n');
  write("CHANGELOG.md", "# Changelog\n\n## [0.4.0] (2026-10-20)\n");
  write("src/index.ts", "export {};\n");
  const base = commit("base");
  const check = (head: string, from = base) => {
    const r = spawnSync(
      "node",
      ["--experimental-strip-types", "--no-warnings", script, from, head],
      { cwd: dir, encoding: "utf8" },
    );
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  return { dir, git, write, commit, base, check };
}

describe("release-only.ts", () => {
  it("a version bump with CHANGELOG and manifest passes and prints release-only", () => {
    const r = repo();
    r.write("package.json", PKG({}, "0.5.0"));
    r.write(".release-please-manifest.json", '{".":"0.5.0"}\n');
    r.write("CHANGELOG.md", "# Changelog\n\n## [0.5.0] (2026-10-21)\n");
    expect(r.check(r.commit())).toEqual({
      code: 0,
      out: "release-only",
      err: "",
    });
  });

  it("a version-only change in any package.json passes, whatever the formatting", () => {
    const r = repo();
    r.write(
      "apps/server/package.json",
      JSON.stringify(JSON.parse(PKG({}, "9.9.9"))),
    );
    expect(r.check(r.commit()).code).toBe(0);
  });

  it("a scripts change in package.json fails and names it", () => {
    const r = repo();
    r.write("package.json", PKG({ scripts: { test: "rm -rf /" } }, "0.5.0"));
    const out = r.check(r.commit());
    expect(out.code).toBe(1);
    expect(out.out).toContain("package.json");
    expect(out.out).toMatch(/other than "version"/);
  });

  it("a dependencies change fails, even next to a version bump", () => {
    const r = repo();
    r.write("package.json", PKG({ dependencies: { a: "2.0.0" } }, "0.5.0"));
    expect(r.check(r.commit()).code).toBe(1);
  });

  it("an engines change, an added key and a removed key all fail", () => {
    for (const extra of [
      { engines: { node: ">=18" } },
      { newKey: true },
      { scripts: undefined },
    ]) {
      const r = repo();
      r.write("package.json", PKG(extra, "0.5.0"));
      expect(r.check(r.commit()).code, JSON.stringify(extra)).toBe(1);
    }
  });

  it("any other file fails and the first offender is named", () => {
    const r = repo();
    r.write("CHANGELOG.md", "# Changelog\n\n## [0.5.0]\n");
    r.write("src/index.ts", "export const x = 1;\n");
    const out = r.check(r.commit());
    expect(out.code).toBe(1);
    expect(out.out).toContain("src/index.ts");
  });

  it("a binary file fails by path", () => {
    const r = repo();
    r.write("logo.png", Buffer.from([0, 1, 2, 255, 0, 3]));
    const out = r.check(r.commit());
    expect(out.code).toBe(1);
    expect(out.out).toContain("logo.png");
  });

  it("a package.json that is not JSON fails", () => {
    const r = repo();
    r.write("package.json", Buffer.from([0, 159, 146, 150]));
    expect(r.check(r.commit()).code).toBe(1);
  });

  it("a new package.json fails (nothing to compare against)", () => {
    const r = repo();
    r.write("apps/new/package.json", PKG({}, "0.0.1"));
    const out = r.check(r.commit());
    expect(out.code).toBe(1);
    expect(out.out).toContain("apps/new/package.json");
  });

  it("a delete fails, even of an allowed file", () => {
    const r = repo();
    r.git("rm", "-q", "CHANGELOG.md");
    const out = r.check(r.commit());
    expect(out.code).toBe(1);
    expect(out.out).toContain("CHANGELOG.md");
    expect(out.out).toMatch(/delet/);
  });

  it("a rename fails, even onto an allowed name", () => {
    const r = repo();
    r.git("mv", "src/index.ts", "CHANGELOG.old.md");
    const a = r.check(r.commit());
    expect(a.code).toBe(1);
    const r2 = repo();
    r2.write("tmp.md", "# Changelog\n\n## [0.4.0] (2026-10-20)\n");
    r2.commit("add");
    const from = r2.git("rev-parse", "HEAD");
    r2.git("rm", "-q", "CHANGELOG.md");
    r2.git("mv", "tmp.md", "CHANGELOG.md");
    const b = r2.check(r2.commit(), from);
    expect(b.code).toBe(1);
    expect(b.out).toMatch(/renamed|delet|tmp\.md/);
  });

  it("a multi-commit merge_group range passes only if the whole range is release-only", () => {
    const r = repo();
    r.write("package.json", PKG({}, "0.5.0"));
    r.commit("release 1");
    r.write("package.json", PKG({}, "0.5.1"));
    r.write("CHANGELOG.md", "# Changelog\n\n## [0.5.1]\n");
    const head = r.commit("release 2");
    expect(r.check(head).code).toBe(0);

    const r2 = repo();
    r2.write("package.json", PKG({}, "0.5.0"));
    r2.commit("release");
    r2.write("src/index.ts", "export const sneaky = 1;\n");
    r2.commit("feature");
    r2.write("CHANGELOG.md", "# Changelog\n\n## [0.5.1]\n");
    const out = r2.check(r2.commit("release again"));
    expect(out.code).toBe(1);
    expect(out.out).toContain("src/index.ts");
  });

  it("an empty diff passes as release-only", () => {
    const r = repo();
    expect(r.check(r.base)).toEqual({ code: 0, out: "release-only", err: "" });
    expect(r.check(r.commit("empty")).code).toBe(0);
  });

  it("a PR branch behind its base is judged by the merge base, not by what main gained", () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "release");
    r.write("package.json", PKG({}, "0.5.0"));
    const head = r.commit("release");
    r.git("checkout", "-q", "main");
    r.write("src/index.ts", "export const onMain = 1;\n");
    const mainTip = r.commit("main moved");
    expect(r.check(head, mainTip).code).toBe(0);
  });

  it("version must be a semver string on both sides", () => {
    for (const version of [5, null, "latest", "1.0", "", "v1.2.3", ["1.0.0"]]) {
      const r = repo();
      r.write("package.json", PKG({ version }, "0.5.0"));
      const out = r.check(r.commit());
      expect(out.code, JSON.stringify(version)).toBe(1);
      expect(out.out).toContain("package.json");
    }
    // a non-semver base side fails too, even when the new side is fine
    const r = repo();
    r.write("package.json", PKG({ version: "latest" }));
    const from = r.commit("odd base");
    r.write("package.json", PKG({}, "0.5.0"));
    expect(r.check(r.commit(), from).code).toBe(1);
    // prerelease and build metadata are semver
    const ok = repo();
    ok.write("package.json", PKG({}, "1.0.0-rc.1+build.5"));
    expect(ok.check(ok.commit()).code).toBe(0);
  });

  it("runs from outside the checkout (the CI copies it out of the base commit)", () => {
    const r = repo();
    r.write("package.json", PKG({}, "0.5.0"));
    const head = r.commit();
    const copy = join(
      mkdtempSync(join(tmpdir(), "ro-copy-")),
      "release-only.ts",
    );
    writeFileSync(copy, readFileSync(script));
    const out = spawnSync(
      "node",
      ["--experimental-strip-types", "--no-warnings", copy, r.base, head],
      { cwd: r.dir, encoding: "utf8" },
    );
    expect(out.stdout.trim()).toBe("release-only");
  });

  it("an unknown sha is a failure, never a pass", () => {
    const r = repo();
    const out = r.check("deadbeef".repeat(5));
    expect(out.code).toBe(1);
  });
});
