import { expect, it } from "vitest";
import { normEmail } from "../src/db/email.js";

it("normEmail trims, NFC-normalizes and lowercases", () => {
  expect(normEmail("  A@X.com ")).toBe("a@x.com");
  // precomposed E-acute vs E + combining acute, and lowercase e-acute, all collide
  expect(normEmail("É@x.com")).toBe(normEmail("É@x.com"));
  expect(normEmail("É@x.com")).toBe(normEmail("é@x.com"));
});
