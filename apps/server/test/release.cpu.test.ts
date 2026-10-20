// B3: the cron's release check is one subrequest, one JSON.parse of the
// release list and one D1 write. Wall clock in local workerd (I/O included,
// fetch stubbed) stays well under the 10 ms Free CPU budget for a full page.
// Runs serially via vitest.cpu.config.ts.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { checkLatestRelease } from "../src/services/release.js";
import { medianMs } from "./cpu-time.js";

// A full page: 100 releases, ~3 KB of notes and 10 assets each (~500 KB).
const page = JSON.stringify(
  Array.from({ length: 100 }, (_, i) => ({
    tag_name: `v0.${100 - i}.0`,
    published_at: "2026-10-19T12:00:00Z",
    draft: false,
    prerelease: false,
    body:
      "* fix something important in the server (#123) (abcdef0)\n".repeat(50) +
      (i % 10 === 0 ? "### BREAKING CHANGES\n* x\n" : ""),
    assets: Array.from({ length: 10 }, (_, j) => ({
      id: j,
      name: `asset-${j}.tgz`,
      browser_download_url: `https://github.com/x/y/releases/download/v0.${i}.0/asset-${j}.tgz`,
    })),
  })),
);

describe("release check CPU", () => {
  it("one check of a full page (stubbed fetch, real D1) is under 8 ms wall", async () => {
    const f = (async () => new Response(page)) as unknown as typeof fetch;
    const ms = await medianMs(() => checkLatestRelease(env, Date.now(), f));
    console.log(`release check (${page.length} B): ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(8);
  });
});
