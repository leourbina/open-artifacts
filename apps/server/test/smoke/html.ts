import {
  ArtifactSummarySchema,
  ContentUrlSchema,
  PublishResultSchema,
  R,
} from "@oa/shared";
import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;

describe.skipIf(!base || !pat)("staging smoke: html publish", () => {
  it("publishes html, serves it sandboxed, and routes /a/:id to the SPA", async () => {
    const auth = { authorization: `Bearer ${pat}` };
    const title = `smoke html ${new Date().toISOString()}`;
    const r = await fetch(`${base}${R.artifacts}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        title,
        format: "html",
        content: "<!doctype html><h1>OA smoke</h1>",
      }),
    });
    expect(r.status).toBe(201);
    const { id } = PublishResultSchema.parse(await r.json());

    const s = await fetch(`${base}${R.artifact(id)}`, { headers: auth });
    expect(s.status).toBe(200);
    expect(ArtifactSummarySchema.parse(await s.json())).toMatchObject({
      id,
      format: "html",
      title,
    });

    const cu = await fetch(`${base}${R.contentUrl(id)}`, { headers: auth });
    expect(cu.status).toBe(200);
    const { url } = ContentUrlSchema.parse(await cu.json());

    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("OA smoke");
    expect(res.headers.get("content-security-policy") ?? "").toContain(
      "sandbox allow-scripts",
    );
    expect(res.headers.get("set-cookie")).toBeNull();

    const page = await fetch(`${base}/a/${id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type") ?? "").toContain("text/html");
  });
});
