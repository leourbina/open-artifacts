import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../src/library/library.css", import.meta.url),
  "utf8",
);

describe("library card and row interaction CSS", () => {
  it("rings the whole card on keyboard focus", () => {
    expect(css).toContain(":has(a:focus-visible)");
  });
  it("drops motion under reduced motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
