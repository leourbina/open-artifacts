import {
  ArtifactSummarySchema,
  PageSchema,
  PublishResultSchema,
  R,
  VersionInfoSchema,
} from "@oa/shared";
import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;

describe.skipIf(!base || !pat)("staging smoke: read", () => {
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${pat}` } });

  it("publishes, then reads the summary, the list and the versions", async () => {
    const r = await fetch(`${base}${R.artifacts}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: `smoke read ${new Date().toISOString()}`,
        format: "markdown",
        content: "# smoke read\n",
      }),
    });
    expect(r.status).toBe(201);
    const { id } = PublishResultSchema.parse(await r.json());

    const s = await get(R.artifact(id));
    expect(s.status).toBe(200);
    expect(ArtifactSummarySchema.parse(await s.json())).toMatchObject({
      id,
      access: "owner",
      currentVersion: 1,
    });

    const l = await get(`${R.artifacts}?scope=mine&limit=10`);
    expect(l.status).toBe(200);
    const page = PageSchema(ArtifactSummarySchema).parse(await l.json());
    expect(page.items.map((a) => a.id)).toContain(id);

    const v = await get(R.versions(id));
    expect(v.status).toBe(200);
    const vs = VersionInfoSchema.array().parse(await v.json());
    expect(vs.map((x) => x.version)).toEqual([1]);
  });
});
