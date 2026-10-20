import { describe, expect, test } from "vitest";
import { inDomains, parseDomains } from "../src/domains.js";

describe("parseDomains", () => {
  test("parses, lowercases, dedupes, accepts IDNA", () => {
    expect(
      parseDomains(
        " A.com ,a.com,xn--bcher-kva.example,shop.xn--p1ai,bad domain,b.co.",
      ),
    ).toEqual({
      domains: ["a.com", "xn--bcher-kva.example", "shop.xn--p1ai"],
      invalid: ["bad domain", "b.co."],
    });
  });

  test("empty and blank entries are skipped, not invalid", () => {
    expect(parseDomains("")).toEqual({ domains: [], invalid: [] });
    expect(parseDomains(" , a.com ,")).toEqual({
      domains: ["a.com"],
      invalid: [],
    });
  });

  test.each([
    "com",
    "-a.com",
    "a-.com",
    "a..com",
    "a.c",
    "a.123",
    "*.a.com",
    "a_b.com",
    `${"a".repeat(64)}.com`,
    `${"a.".repeat(127)}com`,
  ])("rejects %s", (d) => {
    expect(parseDomains(d)).toEqual({ domains: [], invalid: [d] });
  });
});

describe("inDomains", () => {
  test("is exact", () => {
    for (const d of [
      "evil.a.com",
      "a.com.",
      "A.COM",
      "xa.com",
      "",
      undefined,
      1,
    ])
      expect(inDomains(["a.com"], d)).toBe(false);
    expect(inDomains(["a.com"], "a.com")).toBe(true);
  });
});
