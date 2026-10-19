// B3: the cron's release check is one subrequest, one JSON.parse and one D1
// write. Wall clock in local workerd (I/O included, fetch stubbed) stays well
// under the 10 ms Free CPU budget even for a large release body.
// Runs serially via vitest.cpu.config.ts.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { checkLatestRelease } from "../src/services/release.js";
import { medianMs } from "./cpu-time.js";

// ~100 KB: long notes plus an assets list, far above a real release.
const big = JSON.stringify({
  tag_name: "v0.4.0",
  published_at: "2026-10-19T12:00:00Z",
  draft: false,
  prerelease: false,
  body: "* fix something important in the server\n".repeat(1500),
  assets: Array.from({ length: 50 }, (_, i) => ({
    id: i,
    name: `asset-${i}.tgz`,
    browser_download_url: `https://github.com/x/y/releases/download/v0.4.0/asset-${i}.tgz`,
  })),
});

describe("release check CPU", () => {
  it("one check (stubbed fetch, real D1) is under 5 ms wall", async () => {
    const f = (async () => new Response(big)) as unknown as typeof fetch;
    const ms = await medianMs(() => checkLatestRelease(env, Date.now(), f));
    console.log(`release check: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(5);
  });
});
