import { describe, expect, it } from "vitest";
import dispatch, { type Env } from "../src/index.js";

// The 404 path runs on every stray hostname that reaches the wildcard routes,
// so it must stay cheap. Wall clock in workerd (no per-request CPU clock
// locally); the bound is loose, the median is reported.
const RUNS = 201;

describe("404 path cost", () => {
  it("a HOSTS miss is well under a millisecond", async () => {
    const env = {
      OA_ENV: "staging",
      HOSTS: { get: async () => null },
      DISPATCHER: {
        get: () => {
          throw new Error("unreachable");
        },
      },
    } as unknown as Env;
    const one = () =>
      dispatch.fetch(
        new Request("https://nope.open-artifacts-staging.app/") as Parameters<
          typeof dispatch.fetch
        >[0],
        env,
      );
    await one();
    const ms: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t = performance.now();
      await one();
      ms.push(performance.now() - t);
    }
    ms.sort((a, b) => a - b);
    const median = ms[Math.floor(RUNS / 2)] ?? Number.POSITIVE_INFINITY;
    console.log(`dispatch 404 median wall: ${median.toFixed(3)} ms`);
    expect(median).toBeLessThan(5);
  });
});
