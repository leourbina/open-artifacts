import { PublishResultSchema, R } from "@oa/shared";
import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;

describe.skipIf(!base || !pat)("staging smoke: publish", () => {
  it("publishes markdown with a PAT", async () => {
    const r = await fetch(`${base}${R.artifacts}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: `smoke ${new Date().toISOString()}`,
        format: "markdown",
        content: "# smoke\n",
      }),
    });
    expect(r.status).toBe(201);
    const res = PublishResultSchema.parse(await r.json());
    expect(res.version).toBe(1);
    expect(res.url).toBe(`${base}/a/${res.id}`);
    // B7 adds GET R.versions(id) to read it back.
  });
});
