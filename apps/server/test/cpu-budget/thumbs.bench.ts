// Opt-in thumbnail capture CPU bench (needs a local Chromium); see scripts/bench-thumbs.ts.
// THUMBS_BENCH_CHROME=/path/to/chrome-headless-shell pnpm --filter @oa/server bench
import { describe, expect, it } from "vitest";
import { runThumbBench } from "../../scripts/bench-thumbs.js";

const chrome = process.env.THUMBS_BENCH_CHROME;

describe.skipIf(!chrome)("thumbnail capture CPU (Node proxy)", () => {
  it("reports the capture's own CPU per format", async () => {
    const { results, report } = await runThumbBench(chrome as string);
    process.stderr.write(`\n${report}\n\n`);
    expect(results).toHaveLength(4);
  });
});
