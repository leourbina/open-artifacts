import { describe, expect, it } from "vitest";
import { utf8Exceeds } from "../src/utf8.js";

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("utf8Exceeds", () => {
  const cases = [
    "",
    "a".repeat(40_000),
    "é".repeat(30_000),
    "€".repeat(20_000),
    "😀".repeat(15_000),
    // a pair straddling the 16K-unit chunk boundary, and lone surrogates
    `${"a".repeat(16 * 1024 - 1)}😀${"b".repeat(10)}`,
    `${"a".repeat(16 * 1024 - 1)}\ud800${"€".repeat(9000)}`,
    `\udc00${"x".repeat(20_000)}\ud83d`,
  ];
  for (const s of cases)
    it(`matches TextEncoder for length ${s.length}`, () => {
      const n = bytes(s);
      for (const limit of [0, n - 1, n, n + 1, Math.floor(n / 2), n * 3])
        if (limit >= 0) expect(utf8Exceeds(s, limit)).toBe(n > limit);
    });
});
