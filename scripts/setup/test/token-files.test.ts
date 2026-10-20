import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HELP, run } from "../src/index.ts";
import { tokens } from "../src/tokens.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type Opts = NonNullable<Parameters<typeof world>[0]>;
type W = ReturnType<typeof world>;
const parse = (w: W) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, step: string) => parse(w).find((j) => j.step === step);
const HOME = "/home/t";
const D = `${HOME}/.open-artifacts`;
const DEPLOY = "cf-canary-deploy-111";
const ACCESS = "cf-canary-access-222";
const ANALYTICS = "cf-canary-analytics-333";
const bearers = (w: W) => w.auths.map((a) => a.split("Bearer ")[1]);

/** Records each exec's args and env apart, so a token in argv is told from one in env. */
function spy(w: W) {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const exec = w.deps.exec;
  w.deps.exec = async (cmd, args, opts) => {
    calls.push({ args: [cmd, ...args], env: opts?.env });
    return exec(cmd, args, opts);
  };
  return calls;
}
const make = (o: Opts = {}) => world({ ...o, env: { HOME, ...o.env } });

describe("token files", () => {
  it("documents the three flags", () => {
    for (const f of [
      "--token-file",
      "--access-token-file",
      "--analytics-token-file",
    ])
      expect(HELP).toContain(f);
  });

  it("a flag file feeds the deploy token to the API and to wrangler's env", async () => {
    const w = make({ files: { "/t/cf": `${DEPLOY}\n` } });
    const calls = spy(w);
    expect(await run([...HOSTS, "--token-file", "/t/cf"], w.deps, ROOT)).toBe(
      0,
    );
    expect(bearers(w)).toContain(DEPLOY);
    const wr = calls.filter((c) => c.args.includes("wrangler"));
    expect(wr.length).toBeGreaterThan(0);
    for (const c of wr) expect(c.env?.CLOUDFLARE_API_TOKEN).toBe(DEPLOY);
    for (const c of calls) expect(c.args.join(" ")).not.toContain(DEPLOY);
  });

  it("trims trailing whitespace and newlines", async () => {
    const w = make({ files: { "/t/cf": `${DEPLOY}  \r\n\n` } });
    await run([...HOSTS, "--token-file", "/t/cf"], w.deps, ROOT);
    expect(bearers(w)).toContain(DEPLOY);
    expect(bearers(w).some((b) => b?.startsWith(`${DEPLOY} `))).toBe(false);
  });

  it("precedence: env, then the flag file, then the default file", async () => {
    const files = {
      "/t/cf": "flag-tok",
      [`${D}/open-artifacts-cloudflare-token`]: "default-tok",
    };
    const a = make({ files, env: { CLOUDFLARE_API_TOKEN: "env-tok" } });
    await run([...HOSTS, "--token-file", "/t/cf"], a.deps, ROOT);
    expect(bearers(a)).toContain("env-tok");
    expect(bearers(a)).not.toContain("flag-tok");
    const b = make({ files });
    await run([...HOSTS, "--token-file", "/t/cf"], b.deps, ROOT);
    expect(bearers(b)).toContain("flag-tok");
    expect(bearers(b)).not.toContain("default-tok");
    const c = make({ files });
    await run(HOSTS, c.deps, ROOT);
    expect(bearers(c)).toContain("default-tok");
  });

  it("the default path is named after the install: staging stays apart from prod", async () => {
    const files = {
      [`${D}/staging-cloudflare-token`]: "staging-tok",
      [`${D}/open-artifacts-cloudflare-token`]: "prod-tok",
    };
    const w = make({ files });
    const argv = HOSTS.map((a) => (a === "open-artifacts" ? "staging" : a));
    await run(argv, w.deps, ROOT);
    expect(bearers(w)).toContain("staging-tok");
    expect(bearers(w)).not.toContain("prod-tok");
  });

  it("access and analytics tokens come from their files too", async () => {
    const w = make({
      files: {
        [`${D}/open-artifacts-access-token`]: ACCESS,
        "/t/an": ANALYTICS,
      },
    });
    const argv = [...HOSTS, "--analytics-token-file", "/t/an"];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(bearers(w)).toContain(ACCESS);
    expect(w.values).toContain(ANALYTICS);
  });

  it("refuses a group- or world-readable file with exit 2", async () => {
    for (const mode of [0o640, 0o604, 0o644]) {
      const w = make({
        files: { "/t/cf": DEPLOY },
        fileModes: { "/t/cf": mode },
      });
      expect(await run([...HOSTS, "--token-file", "/t/cf"], w.deps, ROOT)).toBe(
        2,
      );
      expect(line(w, "args")).toMatchObject({
        status: "action_required",
        message: "/t/cf is readable by others; run chmod 600 /t/cf",
      });
      expect(w.lines.join("\n").includes(DEPLOY), "token leaked").toBe(false);
      expect(w.ops).toEqual([]);
    }
  });

  it("a missing flag file is an error (exit 1)", async () => {
    const w = make();
    expect(
      await run([...HOSTS, "--access-token-file", "/t/nope"], w.deps, ROOT),
    ).toBe(1);
    expect(line(w, "args")).toMatchObject({ status: "error" });
    expect(line(w, "args").message).toContain("/t/nope");
  });

  it("a missing default file is simply skipped", async () => {
    const w = make();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  });

  it("an empty file is action_required (exit 2)", async () => {
    const w = make({ files: { "/t/cf": " \n" } });
    expect(await run([...HOSTS, "--token-file", "/t/cf"], w.deps, ROOT)).toBe(
      2,
    );
    expect(line(w, "args")).toMatchObject({ status: "action_required" });
    expect(line(w, "args").message).toContain("/t/cf is empty");
  });

  it("an env token makes an unreadable flag file irrelevant", async () => {
    const w = make({
      env: { OA_ACCESS_TOKEN: "env-acc" },
      files: { "/t/ac": ACCESS },
      fileModes: { "/t/ac": 0o644 },
    });
    expect(
      await run([...HOSTS, "--access-token-file", "/t/ac"], w.deps, ROOT),
    ).toBe(0);
  });

  it("canary: no token value reaches output, state, files or argv", async () => {
    const w = make({
      files: {
        "/t/cf": DEPLOY,
        "/t/ac": ACCESS,
        "/t/an": ANALYTICS,
      },
    });
    const calls = spy(w);
    const argv = [
      ...HOSTS,
      ...["--token-file", "/t/cf"],
      ...["--access-token-file", "/t/ac"],
      ...["--analytics-token-file", "/t/an"],
    ];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    const tokensSeen = [DEPLOY, ACCESS, ANALYTICS];
    const hay = [
      ...w.lines,
      JSON.stringify(w.state()),
      ...[...w.files.entries()]
        .filter(([p]) => !p.startsWith("/t/"))
        .map(([, d]) => d),
      ...calls.map((c) => c.args.join(" ")),
    ].join("\n");
    for (const t of tokensSeen)
      expect(hay.includes(t), "token leaked").toBe(false);
    // Access and analytics never reach a child's env; the deploy token does.
    for (const c of calls) {
      expect(c.env?.OA_ACCESS_TOKEN).toBeUndefined();
      expect(c.env?.ANALYTICS_TOKEN).toBeUndefined();
    }
  });
});

describe("token helper: hidden save line", () => {
  it("each token carries a saveCommand named after the install", () => {
    const list = tokens({ name: "staging" });
    const labels = {
      cloudflare: "Cloudflare deploy token",
      access: "Cloudflare Access token",
      analytics: "Cloudflare analytics token",
    };
    expect(list.map((t) => t.saveCommand)).toEqual(
      Object.entries(labels).map(
        ([n, label]) =>
          `bash -c 'set -e; umask 077; d="$HOME/.open-artifacts"; mkdir -p "$d"; chmod 700 "$d"; read -rsp "${label} (hidden, then Enter): " T; echo; [ -n "$T" ] || { echo "nothing entered; not saved"; exit 1; }; rm -f "$d/staging-${n}-token"; printf "%s" "$T" > "$d/staging-${n}-token"; chmod 600 "$d/staging-${n}-token"; echo "saved to $d/staging-${n}-token"'`,
      ),
    );
  });

  it("a hostile name cannot break out of the quoted command", () => {
    const [t] = tokens({ name: "x'; rm -rf ~; '" });
    expect(t?.saveCommand).not.toContain("rm -rf ~; '");
    expect(t?.saveCommand.split("'")).toHaveLength(3);
  });

  it("--token-links --json emits saveCommand per token; --repo keeps the gh line", async () => {
    const w = make();
    expect(
      await run(
        ["--token-links", "--json", "--name", "open-artifacts"],
        w.deps,
        ROOT,
      ),
    ).toBe(0);
    const data = parse(w)[0].data.tokens;
    expect(data[0].saveCommand).toContain("open-artifacts-cloudflare-token");
    expect(data[0].storeAs.kind).toBe("env");
    const gh = make();
    await run(["--token-links", "--json", "--repo", "me/oa"], gh.deps, ROOT);
    const g = parse(gh)[0].data.tokens;
    expect(g[0].storeAs.command).toBe(
      "gh secret set CLOUDFLARE_API_TOKEN -R me/oa",
    );
    expect(g[0].saveCommand).toBeDefined();
  });

  it("the human output shows the save line, not an env export", async () => {
    const w = make();
    await run(["--token-links", "--name", "open-artifacts"], w.deps, ROOT);
    const out = w.lines.join("\n");
    expect(out).toContain("read -rsp");
    expect(out).not.toContain("export CLOUDFLARE_API_TOKEN");
    expect(out).toContain("Never paste a token into the chat.");
  });
});

describe("token file hardening", () => {
  const leaks = (hay: string, ...secrets: string[]) =>
    secrets.some((t) => hay.includes(t));
  const SECRET = "cf-canary-multi-444";

  it("a token with an inner newline is refused without echoing it", async () => {
    const w = make({ files: { "/t/cf": `${SECRET}\nsecond-line-555` } });
    expect(await run([...HOSTS, "--token-file", "/t/cf"], w.deps, ROOT)).toBe(
      2,
    );
    expect(line(w, "args").message).toBe("/t/cf: the token must be one line");
    expect(leaks(w.lines.join("\n"), SECRET, "second-line-555")).toBe(false);
  });

  it.each(["has space-666", "tab\tbed-777", "uni\u00e9code-888"])(
    "a non-printable-ASCII token (%j) is refused",
    async (tok) => {
      const w = make({ files: { "/t/cf": tok } });
      expect(await run([...HOSTS, "--token-file", "/t/cf"], w.deps, ROOT)).toBe(
        2,
      );
      expect(leaks(w.lines.join("\n"), tok)).toBe(false);
    },
  );

  it("never echoes a path without a slash (it may be a pasted token)", async () => {
    const pasted = "cfut_PASTEDtoken1234567890";
    for (const files of [
      {} as Record<string, string>,
      { [pasted]: "" },
      { [pasted]: "a\nb" },
    ]) {
      const w = make({ files });
      const rc = await run([...HOSTS, "--token-file", pasted], w.deps, ROOT);
      expect(rc).not.toBe(0);
      expect(leaks(w.lines.join("\n"), pasted)).toBe(false);
      expect(w.lines.join("\n")).toContain("the token file you passed");
    }
    const w = make({
      files: { [pasted]: "x-token-999" },
      fileModes: { [pasted]: 0o644 },
    });
    await run([...HOSTS, "--token-file", pasted], w.deps, ROOT);
    expect(leaks(w.lines.join("\n"), pasted)).toBe(false);
  });

  it("expands a bare ~ as well as ~/", async () => {
    const w = make({ files: { [HOME]: DEPLOY, [`${HOME}/cf`]: DEPLOY } });
    await run([...HOSTS, "--token-file", "~"], w.deps, ROOT);
    expect(bearers(w)).toContain(DEPLOY);
    const v = make({ files: { [`${HOME}/cf`]: DEPLOY } });
    await run([...HOSTS, "--token-file", "~/cf"], v.deps, ROOT);
    expect(bearers(v)).toContain(DEPLOY);
  });

  it("refuses when permissions cannot be checked", async () => {
    const w = make({ files: { "/t/cf": DEPLOY } });
    const fs = w.deps.fs as { readToken?: unknown };
    fs.readToken = undefined;
    expect(await run([...HOSTS, "--token-file", "/t/cf"], w.deps, ROOT)).toBe(
      2,
    );
    expect(line(w, "args").message).toContain("cannot check the permissions");
  });

  it("refuses a file owned by someone else", async () => {
    const w = make({ files: { "/t/cf": DEPLOY } });
    const fs = w.deps.fs as {
      readToken: (p: string) => { uid: number } | null;
    };
    const real = fs.readToken;
    fs.readToken = (p) => {
      const f = real(p);
      return f && { ...f, uid: f.uid + 1 };
    };
    expect(await run([...HOSTS, "--token-file", "/t/cf"], w.deps, ROOT)).toBe(
      2,
    );
    expect(line(w, "args").message).toContain("regular file you own");
  });

  it("a failed wrangler echoing the token is scrubbed from the output", async () => {
    const w = make({ files: { "/t/cf": DEPLOY } });
    const exec = w.deps.exec;
    w.deps.exec = async (cmd, args, opts) =>
      args.includes("whoami")
        ? {
            code: 1,
            stdout: "",
            stderr: `bad header Authorization: Bearer ${DEPLOY}`,
          }
        : exec(cmd, args, opts);
    const rc = await run([...HOSTS, "--token-file", "/t/cf"], w.deps, ROOT);
    expect(rc).toBe(1);
    expect(leaks(w.lines.join("\n"), DEPLOY)).toBe(false);
    expect(w.lines.join("\n")).toContain("[redacted]");
    expect(leaks(JSON.stringify(w.state()), DEPLOY)).toBe(false);
  });

  it("--ci with token files leaks nothing and writes no state", async () => {
    const w = make({
      files: { "/t/cf": DEPLOY, "/t/ac": ACCESS, "/t/an": ANALYTICS },
    });
    const calls = spy(w);
    const ci = HOSTS.filter((a) => a !== "--yes");
    const argv = [
      ...ci,
      "--ci",
      ...["--token-file", "/t/cf"],
      ...["--access-token-file", "/t/ac"],
      ...["--analytics-token-file", "/t/an"],
    ];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    const hay = [
      ...w.lines,
      ...calls.map((c) => c.args.join(" ")),
      ...[...w.files.entries()]
        .filter(([p]) => !p.startsWith("/t/"))
        .map(([, d]) => d),
    ].join("\n");
    expect(leaks(hay, DEPLOY, ACCESS, ANALYTICS)).toBe(false);
    expect(w.files.has("/repo/.openartifacts/state.json")).toBe(false);
  });
});

describe("real token file reads", () => {
  it("refuses a symlink, reads a regular 0600 file, reports a missing one", async () => {
    const { mkdtempSync, symlinkSync, writeFileSync, chmodSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { realFs } = await import("../src/cf.ts");
    const dir = mkdtempSync(join(tmpdir(), "oa-tok-"));
    const f = join(dir, "t");
    writeFileSync(f, "tok\n");
    chmodSync(f, 0o600);
    symlinkSync(f, join(dir, "link"));
    expect(realFs.readToken?.(f)).toMatchObject({
      text: "tok\n",
      mode: 0o600,
      isFile: true,
      uid: process.getuid?.(),
    });
    expect(realFs.readToken?.(join(dir, "link"))?.isFile).toBe(false);
    expect(realFs.readToken?.(join(dir, "none"))).toBeNull();
    expect(realFs.readToken?.(dir)?.isFile).toBe(false);
    // A FIFO must not hang the open.
    const fifo = join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    const t0 = Date.now();
    expect(realFs.readToken?.(fifo)?.isFile).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
