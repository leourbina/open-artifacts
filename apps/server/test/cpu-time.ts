import { env } from "cloudflare:workers";
import { expect } from "vitest";

/** Samples per median. */
export const REPEATS = 7;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.POSITIVE_INFINITY;
};

const wall = async (f: () => Promise<unknown>) => {
  const t = performance.now();
  await f();
  return performance.now() - t;
};

/** Median wall ms of `runs` calls of `f`, after one warm-up call. */
export async function medianMs(
  f: () => Promise<unknown>,
  runs = REPEATS,
): Promise<number> {
  await f();
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) ms.push(await wall(f));
  return median(ms);
}

/**
 * `base` and `f` measured interleaved (one warm-up each, then alternating),
 * so a slow stretch of the runner hits both. `delta` is the median of the
 * per-pair differences `f - base`.
 */
export async function pairedMs(
  base: () => Promise<unknown>,
  f: () => Promise<unknown>,
  runs = REPEATS,
): Promise<{ base: number; ms: number; delta: number }> {
  await base();
  await f();
  const b: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < runs; i++) {
    b.push(await wall(base));
    m.push(await wall(f));
  }
  return {
    base: median(b),
    ms: median(m),
    delta: median(m.map((x, i) => x - (b[i] ?? 0))),
  };
}

/**
 * `maxMs` scaled to the runner: × clamp(baseMs / refMs, 1, 4), where
 * `baseMs` is the test's own tiny baseline on this runner and `refMs` the
 * same baseline measured on a dev laptop. A slower runner (CI) gets a
 * proportionally wider bound, never narrower, at most 4×.
 */
export function scaledBound(
  baseMs: number,
  refMs: number,
  maxMs: number,
): number {
  return maxMs * Math.min(4, Math.max(1, baseMs / refMs));
}

/** Asserts `ms < scaledBound(baseMs, refMs, maxMs)` and annotates the scale. */
export async function calibrated(
  annotate: (message: string) => Promise<unknown>,
  label: string,
  {
    ms,
    baseMs,
    refMs,
    maxMs,
  }: Record<"ms" | "baseMs" | "refMs" | "maxMs", number>,
): Promise<void> {
  const bound = scaledBound(baseMs, refMs, maxMs);
  await annotate(
    `${label}: ${ms.toFixed(1)} ms < ${bound.toFixed(1)} (${maxMs} × ${(bound / maxMs).toFixed(2)}; base ${baseMs.toFixed(1)} ms, ref ${refMs})`,
  );
  expect(ms, label).toBeLessThan(bound);
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
