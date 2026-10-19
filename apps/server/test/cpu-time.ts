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
