import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;

describe.skipIf(!base)("staging smoke", () => {
  it("GET /healthz", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
});
