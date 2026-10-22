import { expect, it } from "vitest";
import { isAsciiEmail, normalizeEmail } from "../src/email.js";

it("normalizeEmail trims and lowercases printable-ASCII emails", () => {
  expect(normalizeEmail("  A@X.com ")).toBe("a@x.com");
});

it("normalizeEmail rejects non-ASCII (no Unicode folding onto ASCII accounts)", () => {
  for (const bad of [
    "\u212Aim@x.com",
    "É@x.com",
    "é@x.com",
    "a b@x.com",
    "a@x.com\u0000",
    "",
    "noat",
    "@x.com",
    "a@",
  ]) {
    expect(isAsciiEmail(bad)).toBe(false);
    expect(normalizeEmail(bad)).toBeNull();
  }
  expect(isAsciiEmail(" Kim@X.com ")).toBe(true);
});

it("normalizeEmail is idempotent and exported from the package root", async () => {
  const root = await import("../src/index.js");
  expect(root.normalizeEmail).toBe(normalizeEmail);
  expect(normalizeEmail("a@x.com")).toBe("a@x.com");
  expect(normalizeEmail("\tB@Y.ORG\n")).toBe("b@y.org");
});
