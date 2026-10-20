import { describe, expect, it } from "vitest";
import { isId, newId, TUNABLES } from "../src/index.js";

describe("tunables", () => {
  it("PUBLIC_HOME id check matches isId", () => {
    for (const v of [newId(), newId(), "short", "0OIl0OIl0OIl0OIl", ""]) {
      expect(TUNABLES.PUBLIC_HOME?.check(v) === undefined || v === "").toBe(
        isId(v) || v === "",
      );
    }
  });
});
