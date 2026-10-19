// Opt-in publish/list CPU profile (Node proxy); see scripts/bench-publish.ts.
// BENCH_PUBLISH=1 pnpm --filter @oa/server bench
import { describe, expect, it } from "vitest";
import {
  runInlineCandidates,
  runPublishBench,
} from "../../scripts/bench-publish.js";

describe.skipIf(!process.env.BENCH_PUBLISH)(
  "publish and list CPU profile",
  () => {
    it("reports per-request CPU and hot frames", async () => {
      const report = await runPublishBench();
      process.stderr.write(`\n${report}\n\n`);
      expect(report).toContain("list 25");
    });

    it("inline candidates: CPU per size and its parse share", async () => {
      const report = await runInlineCandidates();
      process.stderr.write(`\n${report}\n\n`);
      expect(report).toContain("128 KB");
    });
  },
);
