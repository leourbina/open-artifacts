import { R, USAGE_LIMITS } from "@oa/shared";
import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;

// Each key comes from its own Workers Analytics GraphQL alias; a missing one
// means that query failed (check WORKER_NAME / OAUTH_KV_ID or the field names).
// Limits follow the instance's plan (staging runs on Workers Paid).
const KEYS = ["cpu_limit_hits", "cpu_p99_ms", "kv_writes"] as const;

describe.skipIf(!base || !pat)("staging smoke: usage", () => {
  it("reports CPU-limit, CPU p99 and KV-write metrics from analytics", async () => {
    const r = await fetch(`${base}${R.usage}`, {
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      available?: boolean;
      plan?: "free" | "paid";
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
    expect(["free", "paid"]).toContain(body.plan);
    const limits = USAGE_LIMITS[body.plan ?? "free"];
    for (const key of KEYS) {
      const limit = limits[key];
      const m = body.metrics?.find((x) => x.key === key);
      expect(m, `metric ${key}`).toBeDefined();
      expect(typeof m?.used, `${key}.used`).toBe("number");
      expect(m?.used as number).toBeGreaterThanOrEqual(0);
      expect(m?.limit, `${key}.limit`).toBe(limit);
    }
  });
});
