import { R } from "@oa/shared";
import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;

// Each key comes from its own Workers Analytics GraphQL alias; a missing one
// means that query failed (check WORKER_NAME / OAUTH_KV_ID or the field names).
const EXPECTED = { cpu_limit_hits: 0, cpu_p99_ms: 10, kv_writes: 1000 };

describe.skipIf(!base || !pat)("staging smoke: usage", () => {
  it("reports CPU-limit, CPU p99 and KV-write metrics from analytics", async () => {
    const r = await fetch(`${base}${R.usage}`, {
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      available?: boolean;
      metrics?: { key?: string; used?: unknown; limit?: unknown }[];
    };
    // No ANALYTICS_TOKEN on the instance: nothing to check yet (#187).
    if (body.available === false && (body.metrics ?? []).length === 0) {
      console.warn(
        "smoke usage: analytics not configured (available=false); skipping metric checks",
      );
      return;
    }
    expect(body.available).toBe(true);
    for (const [key, limit] of Object.entries(EXPECTED)) {
      const m = body.metrics?.find((x) => x.key === key);
      expect(m, `metric ${key}`).toBeDefined();
      expect(typeof m?.used, `${key}.used`).toBe("number");
      expect(m?.used as number).toBeGreaterThanOrEqual(0);
      expect(m?.limit, `${key}.limit`).toBe(limit);
    }
  });
});
