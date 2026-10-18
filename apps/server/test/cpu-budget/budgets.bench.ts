// Opt-in CPU budgets (Node proxy, p95 at 1.5× headroom): `pnpm --filter @oa/server bench`.
// Not part of `pnpm test`: timings depend on the host. See scripts/bench.ts.
import { describe, expect, it } from "vitest";
import { runAll, table } from "../../scripts/bench.js";

describe("CPU budgets (p95, Node proxy)", () => {
  it("every hot path is within budget × 1.5", async () => {
    const filter = process.env.BENCH_FILTER
      ? new RegExp(process.env.BENCH_FILTER, "i")
      : undefined;
    const results = await runAll(filter);
    process.stderr.write(`\n${table(results)}\n\n`);
    expect(results.filter((r) => !r.pass).map((r) => r.name)).toEqual([]);
  });
});
