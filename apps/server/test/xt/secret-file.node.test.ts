import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSecretFile } from "./secret-file.js";

const SECRET = "s3cret-value";

describe("readSecretFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "xt-secret-"));
  const file = (mode: number, body = `${SECRET}\n`) => {
    const p = join(dir, `k-${mode.toString(8)}-${Math.random()}`);
    writeFileSync(p, body);
    chmodSync(p, mode);
    return p;
  };
  /** Refused, and neither message nor stack holds the secret. */
  const refused = (fn: () => unknown, msg: RegExp) => {
    let err: unknown;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const text = `${(err as Error).message}\n${(err as Error).stack}`;
    expect(text).toMatch(msg);
    expect(text).not.toContain(SECRET);
  };

  it("reads a 0600 (or 0400) file, trimmed", () => {
    expect(readSecretFile(file(0o600))).toBe(SECRET);
    expect(readSecretFile(file(0o400))).toBe(SECRET);
  });

  it.each([0o640, 0o644, 0o604, 0o660, 0o666, 0o610, 0o601])(
    "refuses mode %o",
    (mode) => refused(() => readSecretFile(file(mode)), /wider than 0600/),
  );

  it("refuses a symlink, even to a 0600 file", () => {
    const link = join(dir, `link-${Math.random()}`);
    symlinkSync(file(0o600), link);
    refused(() => readSecretFile(link), /symlink or unreadable/);
  });

  it("refuses a file owned by another uid", () => {
    const p = file(0o600);
    const uid = (process.getuid?.() ?? 0) + 1;
    refused(() => readSecretFile(p, { uid }), /not owned by uid/);
  });

  it("refuses a FIFO without blocking on it", () => {
    const p = join(dir, `fifo-${Math.random()}`);
    execFileSync("mkfifo", ["-m", "600", p]);
    refused(() => readSecretFile(p), /not a regular file/);
  });

  it("refuses a directory", () => {
    const d = mkdtempSync(join(dir, "d-"));
    chmodSync(d, 0o700);
    refused(() => readSecretFile(d), /not a regular file/);
  });

  it("refuses an empty file", () => {
    refused(() => readSecretFile(file(0o600, "\n")), /empty/);
  });
});
