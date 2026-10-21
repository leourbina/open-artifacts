import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSecretFile } from "./secret-file.js";

describe("readSecretFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "xt-secret-"));
  const file = (mode: number, body = "s3cret\n") => {
    const p = join(dir, `k-${mode.toString(8)}-${Math.random()}`);
    writeFileSync(p, body);
    chmodSync(p, mode);
    return p;
  };

  it("reads a 0600 (or 0400) file, trimmed", () => {
    expect(readSecretFile(file(0o600))).toBe("s3cret");
    expect(readSecretFile(file(0o400))).toBe("s3cret");
  });

  it.each([0o640, 0o644, 0o604, 0o660, 0o666])("refuses mode %o", (mode) => {
    const p = file(mode);
    expect(() => readSecretFile(p)).toThrow(/wider than 0600/);
    try {
      readSecretFile(p);
    } catch (e) {
      expect(String(e)).not.toContain("s3cret");
    }
  });

  it("refuses an empty file", () => {
    expect(() => readSecretFile(file(0o600, "\n"))).toThrow(/empty/);
  });
});
