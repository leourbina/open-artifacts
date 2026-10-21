import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isId, newId, TUNABLES } from "../src/index.js";

const src = (f: string) =>
  readFileSync(join(import.meta.dirname, "../src", f), "utf8");
const idRe = (s: string) => /const ID_RE = (\/.*\/);/.exec(s)?.[1];

describe("tunables", () => {
  it("tunables.ts copies ids.ts's ID_RE exactly", () => {
    expect(idRe(src("tunables.ts"))).toBeDefined();
    expect(idRe(src("tunables.ts"))).toBe(idRe(src("ids.ts")));
  });
  it("PUBLIC_HOME id check matches isId", () => {
    const base = newId();
    for (const v of [
      newId(),
      base.slice(0, 15),
      `${base}x`,
      "short",
      "0OIl0OIl0OIl0OIl",
      "",
    ]) {
      expect(TUNABLES.PUBLIC_HOME?.check(v) === undefined || v === "").toBe(
        isId(v) || v === "",
      );
    }
  });
});
