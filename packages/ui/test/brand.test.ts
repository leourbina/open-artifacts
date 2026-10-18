import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brand } from "../src/brand/index";

const read = (url: string) => readFileSync(fileURLToPath(url), "utf8");
const root = new URL("../../../", import.meta.url);

describe("brand assets", () => {
  it("every exported URL is an existing, font-free SVG", () => {
    for (const url of Object.values(brand)) {
      expect(existsSync(fileURLToPath(url))).toBe(true);
      const svg = read(url);
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(svg).toContain("<title>Open Artifacts</title>");
      expect(svg).not.toMatch(/<text|font-family|<image/);
    }
  });

  it("mark.svg themes through currentColor and the accent var", () => {
    const svg = read(brand.mark);
    expect(svg).toContain('fill="currentColor"');
    expect(svg).toContain("var(--oa-brand-accent, var(--oa-accent, #2350D0))");
  });

  it("favicon switches to dark ink and the apps ship identical copies", () => {
    const svg = read(brand.favicon);
    expect(svg).toContain("@media (prefers-color-scheme: dark)");
    expect(svg).toContain("#E9EBEE");
    for (const app of ["dashboard", "landing"]) {
      expect(read(new URL(`apps/${app}/public/favicon.svg`, root).href)).toBe(
        svg,
      );
    }
  });

  it("og.png is 1200x630", () => {
    const png = readFileSync(
      fileURLToPath(new URL("apps/landing/public/og.png", root)),
    );
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });
});
