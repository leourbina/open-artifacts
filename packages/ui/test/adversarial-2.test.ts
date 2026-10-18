import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tokens } from "../src/index";

const pkg = fileURLToPath(new URL("..", import.meta.url));

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Runs the real sync test against a mutated tokens.css; drift must make it fail.
function syncTestPassesWith(mutate: (css: string) => string): boolean {
  const dir = mkdtempSync(join(pkg, ".mut-"));
  cpSync(join(pkg, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(pkg, "test/sync.test.ts"), join(dir, "test/sync.test.ts"));
  const cssPath = join(dir, "src/tokens/tokens.css");
  writeFileSync(cssPath, mutate(readFileSync(cssPath, "utf8")));
  const r = spawnSync(
    join(pkg, "node_modules/.bin/vitest"),
    ["run", "--root", dir, "test/sync.test.ts"],
    { encoding: "utf8" },
  );
  rmSync(dir, { recursive: true });
  return r.status === 0;
}

describe("adversarial round 2", () => {
  it("sync test catches an override whose last declaration has no semicolon", () => {
    expect(
      syncTestPassesWith((css) => `${css}\n:root { --oa-text: #ff0000 }\n`),
    ).toBe(false);
  });

  // DIRECTION: surface-2 = raised rows, accent-soft = tinted row backgrounds; rows hold checkboxes.
  it.each([
    ["light", "surface-2"],
    ["dark", "surface-2"],
  ] as const)("border-strong is >= 3:1 on row fills (%s, %s)", (t, bg) => {
    expect(
      contrast(
        tokens["border-strong"]?.[t] as string,
        tokens[bg]?.[t] as string,
      ),
    ).toBeGreaterThanOrEqual(3);
  });
});
