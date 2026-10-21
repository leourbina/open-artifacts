import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;

// Semver with an optional prerelease and build suffix: 0.3.0, 0.3.0-dev+abc1234.
const SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

describe.skipIf(!base)("staging smoke", () => {
  it("GET /healthz", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    // Staging runs PLAN=paid (wrangler.staging.jsonc); /healthz reports it.
    // Hosted installs also report an opaque installId; self-host omits it.
    const body = (await r.json()) as {
      ok: boolean;
      plan: string;
      version: string;
      installId?: string;
    };
    const { installId, ...rest } = body;
    expect(rest).toEqual({
      ok: true,
      plan: "paid",
      version: expect.stringMatching(SEMVER),
    });
    if (installId !== undefined) expect(installId).toMatch(/^\S+$/);
  });
});
