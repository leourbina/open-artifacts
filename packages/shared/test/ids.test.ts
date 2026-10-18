import { describe, expect, it } from "vitest";
import { isId, isPat, newId, newPat } from "../src/ids.js";

describe("ids", () => {
  it("newId matches base58 16", () => {
    expect(newId()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{16}$/);
    expect(isId(newId())).toBe(true);
    expect(isId("0OIl000000000000")).toBe(false);
    expect(isId("short")).toBe(false);
  });
  it("no duplicates in 10k", () => {
    const s = new Set<string>();
    for (let i = 0; i < 10_000; i++) s.add(newId());
    expect(s.size).toBe(10_000);
  });
  it("pat", () => {
    expect(isPat(newPat())).toBe(true);
    expect(newPat()).toMatch(/^oa_pat_[1-9A-HJ-NP-Za-km-z]{32}$/);
    expect(isPat("oa_pat_short")).toBe(false);
  });
});
