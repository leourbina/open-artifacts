import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const doc = readFileSync(
  fileURLToPath(new URL("../src/content/docs/runtime-api.md", import.meta.url)),
  "utf8",
);

describe("runtime-api docs", () => {
  // packages/runtime delivers { docs: [], deleted: [], resync: true } after a
  // reconnect; pages must refetch on it.
  it("explains resync and refetches on it in the example", () => {
    expect(doc).toContain("{ docs: [], deleted: [], resync: true }");
    expect(doc).toMatch(/if \(e\.resync\) return refetch\(\);/);
  });
});
