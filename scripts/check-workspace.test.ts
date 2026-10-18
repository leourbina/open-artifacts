import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const packages: Record<string, string> = {
  "apps/server": "@oa/server",
  "apps/dashboard": "@oa/dashboard",
  "apps/landing": "@oa/landing",
  "packages/shared": "@oa/shared",
  "packages/ui": "@oa/ui",
  "packages/runtime": "@oa/runtime",
  "packages/render": "@oa/render",
  "scripts/setup": "@oa/setup",
};

describe("workspace", () => {
  it("declares globs", () => {
    const ws = read("pnpm-workspace.yaml");
    for (const g of ["apps/*", "packages/*", "scripts/*"]) {
      expect(ws).toContain(g);
    }
  });

  it.each(Object.entries(packages))("%s is %s", (dir, name) => {
    expect(existsSync(join(root, dir, "package.json"))).toBe(true);
    const pkg = JSON.parse(read(`${dir}/package.json`));
    expect(pkg.name).toBe(name);
    expect(pkg.type).toBe("module");
  });

  it("gitignores required paths", () => {
    const lines = read(".gitignore")
      .split("\n")
      .map((l) => l.trim());
    for (const p of [
      ".superpowers/",
      ".openartifacts/",
      "node_modules/",
      "dist/",
      ".wrangler/",
      "apps/server/wrangler.jsonc",
    ]) {
      expect(lines).toContain(p);
    }
  });
});
