import type { AccessLevel } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { meetsLevel } from "../src/auth/authz.js";

// requireAccess compares through meetsLevel. "manager" (hosted M1) has the
// owner's rank but must never pass an owner check (single transfer etc.).
describe("meetsLevel", () => {
  it('"owner" is exact: a manager is refused', () => {
    expect(meetsLevel("manager", "owner")).toBe(false);
    expect(meetsLevel("owner", "owner")).toBe(true);
  });
  it("lower minimums rank as before", () => {
    const L: AccessLevel[] = ["viewer", "editor", "manager", "owner"];
    for (const level of L) {
      expect(meetsLevel(level, "viewer")).toBe(true);
      expect(meetsLevel(level, "editor")).toBe(level !== "viewer");
    }
    expect(meetsLevel("editor", "manager")).toBe(false);
    expect(meetsLevel("owner", "manager")).toBe(true);
  });
});
