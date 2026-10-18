import { expect, it } from "vitest";
import { isAsciiEmail, normEmail } from "../src/db/email.js";

it("normEmail trims and lowercases printable-ASCII emails", () => {
  expect(normEmail("  A@X.com ")).toBe("a@x.com");
});

it("normEmail rejects non-ASCII (no Unicode folding onto ASCII accounts)", () => {
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
    expect(normEmail(bad)).toBeNull();
  }
  expect(isAsciiEmail(" Kim@X.com ")).toBe(true);
});
