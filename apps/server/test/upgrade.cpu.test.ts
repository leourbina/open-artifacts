// GET /upgrade.md CPU: one regex fill of the pre-rendered template, memoized
// per isolate. Wall-clock budgets via vitest.cpu.config.ts (median of 5).
import { describe, expect, it } from "vitest";
import { renderUpgrade } from "../src/mcp/upgrade.js";
import { medianMs as time } from "./cpu-time.js";
import { APP, callWorker, E } from "./mcp-helpers.js";

describe("GET /upgrade.md CPU (Free: 10 ms)", () => {
  it("first fill (a new host) is well under 1 ms of work", async () => {
    let n = 0;
    const ms = await time(() =>
      renderUpgrade({
        APP_HOST: `h${n++}.example.com`,
        ENVIRONMENT: "production",
        WORKER_NAME: "w",
      }),
    );
    expect(ms).toBeLessThan(1);
  });

  it("the route, memoized, is under 2 ms end to end", async () => {
    const ms = await time(() =>
      callWorker(new Request(`${APP}/upgrade.md`), E()).then((r) => r.text()),
    );
    expect(ms).toBeLessThan(2);
  });
});
