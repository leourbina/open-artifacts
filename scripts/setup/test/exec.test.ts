import { describe, expect, it } from "vitest";
import { realDeps } from "../src/cf.ts";

describe("realDeps.exec", () => {
  it("resolves with the child's exit code when the child exits without reading a large stdin", async () => {
    const r = await realDeps().exec(
      process.execPath,
      ["-e", "process.exit(0)"],
      { input: "x".repeat(1024 * 1024) },
    );
    expect(r.code).toBe(0);
  });
});
