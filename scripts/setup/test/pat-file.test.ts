import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realFs } from "../src/cf.ts";
import { run } from "../src/index.ts";
import { hostSlug, patTokenFile } from "../src/secret-file.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const HOME = "/home/test";
const FILE = `${HOME}/.open-artifacts/app-example-com-pat-token`;
const line = (w: W, s: string) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === s);

describe("host slug (matches @oa/shared secretFile)", () => {
  it("lowercases and turns dots into dashes", () => {
    expect(hostSlug("staging.open-artifacts.com")).toBe(
      "staging-open-artifacts-com",
    );
    expect(hostSlug("App.Example.COM")).toBe("app-example-com");
  });
  it("truncates a long host and adds a 6-character hash, stably", () => {
    const long = `${"a".repeat(70)}.example.com`;
    const s = hostSlug(long);
    expect(s.length).toBeLessThanOrEqual(48);
    expect(s).toMatch(/^a+-[0-9a-f]{6}$/);
    expect(hostSlug(long)).toBe(s);
    expect(hostSlug(`${long}x`)).not.toBe(s);
  });
  it("the file lives under ~/.open-artifacts", () => {
    expect(patTokenFile("/h", "staging.open-artifacts.com")).toBe(
      "/h/.open-artifacts/staging-open-artifacts-com-pat-token",
    );
  });
});

describe("#2: the minted PAT goes to a file, not stdout", () => {
  const go = async (extra: string[] = []) => {
    const w = world({ env: { HOME } });
    expect(await run([...HOSTS, ...extra], w.deps, ROOT)).toBe(0);
    return w;
  };

  it("writes the 0600 file and reports data.tokenFile, never data.token", async () => {
    const w = await go();
    const d = line(w, "owner-token").data;
    expect(d.tokenFile).toBe(FILE);
    expect(d).not.toHaveProperty("token");
    const pat = (w.files.get(FILE) ?? "").trim();
    expect(pat).toMatch(/^oa_pat_/);
    expect(w.secretWrites).toEqual([FILE]);
    // canary: the token is in the file only
    const hay = [
      ...w.lines,
      ...[...w.files].filter(([k]) => k !== FILE).map(([, v]) => v),
      ...w.argv,
      ...w.prompts,
    ].join("\n");
    expect(hay).not.toContain(pat);
  });

  it("--print-token restores data.token", async () => {
    const w = await go(["--print-token"]);
    const d = line(w, "owner-token").data;
    expect(d.token).toBe((w.files.get(FILE) ?? "").trim());
    expect(d.tokenFile).toBe(FILE);
  });

  it("--ci writes no file and prints no token, even with --print-token", async () => {
    const w = world({ env: { HOME } });
    const ci = [...HOSTS.filter((a) => a !== "--yes"), "--ci", "--print-token"];
    expect(await run(ci, w.deps, ROOT)).toBe(0);
    expect(w.secretWrites).toEqual([]);
    const d = line(w, "owner-token").data;
    expect(d).not.toHaveProperty("token");
    expect(d).not.toHaveProperty("tokenFile");
    expect(w.lines.join("\n")).not.toMatch(/oa_pat_/);
  });

  it("agent-config snippets read the file and never embed the token or {env:OA_TOKEN}", async () => {
    const w = await go();
    const cfg = line(w, "agent-config").data;
    const pat = (w.files.get(FILE) ?? "").trim();
    expect(cfg.snippets.claudeCode).toContain(
      "$(cat ~/.open-artifacts/app-example-com-pat-token)",
    );
    expect(cfg.snippets.opencode).toContain(
      "{file:~/.open-artifacts/app-example-com-pat-token}",
    );
    expect(cfg.snippets.opencode).not.toContain("{env:OA_TOKEN}");
    expect(JSON.stringify(cfg)).not.toContain(pat);
  });

  it("a write failure is an error that names the file, not the token", async () => {
    const w = world({ env: { HOME } });
    w.deps.fs = {
      ...(w.deps.fs as object),
      writeSecret: () => {
        throw new Error("EACCES");
      },
    } as never;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    const l = line(w, "owner-token");
    expect(l.message).toContain(FILE);
    expect(w.lines.join("\n")).not.toMatch(/oa_pat_/);
  });
});

describe("realFs.writeSecret", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "oa-pat-"));

  it("creates the directory 0700 and the file 0600", () => {
    const f = join(dir(), ".open-artifacts", "x-pat-token");
    realFs.writeSecret?.(f, "secret\n");
    expect(readFileSync(f, "utf8")).toBe("secret\n");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(f, "..")).mode & 0o777).toBe(0o700);
  });

  it("replaces an existing file (even a loose or symlinked one) with a fresh 0600 file", () => {
    const d = dir();
    const f = join(d, ".open-artifacts", "x-pat-token");
    mkdirSync(join(d, ".open-artifacts"), { mode: 0o755 });
    const target = join(d, "elsewhere");
    writeFileSync(target, "keep", { mode: 0o644 });
    symlinkSync(target, f);
    realFs.writeSecret?.(f, "new\n");
    expect(lstatSync(f).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(readFileSync(f, "utf8")).toBe("new\n");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, ".open-artifacts")).mode & 0o777).toBe(0o700);
  });
});
