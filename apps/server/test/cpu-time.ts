import { env } from "cloudflare:workers";
import { expect } from "vitest";

/** Median wall ms of `runs` calls of `f`, after one warm-up call. */
export async function medianMs(
  f: () => Promise<unknown>,
  runs = 5,
): Promise<number> {
  await f();
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await f();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return ms[Math.floor(runs / 2)] ?? Number.POSITIVE_INFINITY;
}

/**
 * An absolute wall-clock bound: always annotated, asserted only in strict
 * mode (`pnpm test:cpu:strict`, binding CPU_STRICT=1). Absolute wall ms in
 * local workerd depends on the runner and ticks in whole ms, so it is a
 * report, not a CI gate; relative and size-scaling checks stay assertions
 * (docs/ops/cpu-budget.md).
 */
export async function budget(
  annotate: (message: string) => Promise<unknown>,
  label: string,
  ms: number,
  maxMs: number,
): Promise<void> {
  await annotate(`${label}: ${ms} ms (budget ${maxMs})`);
  if ((env as { CPU_STRICT?: string }).CPU_STRICT === "1")
    expect(ms, label).toBeLessThanOrEqual(maxMs);
}
