import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { checkBundle, MAX_GZIP } from "../scripts/check-size.mjs";

const dist = join(import.meta.dirname, "..", "dist");

// `pnpm build` runs the same check; this covers it when dist exists.
describe.skipIf(!existsSync(join(dist, "manifest.json")))("bundle", () => {
  it("entry is < 400 KB gzip with mermaid, pdf.js and grammars lazy", () => {
    const r = checkBundle(dist);
    expect(r.errors).toEqual([]);
    expect(r.gzip).toBeLessThan(MAX_GZIP);
  });
});
