import {
  ArtifactSummarySchema,
  ContentUrlSchema,
  PublishResultSchema,
  R,
} from "@oa/shared";
import { afterAll, describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;

// Best-effort cleanup: private artifacts created by this file, soft-deleted afterwards.
const created: string[] = [];
afterAll(async () => {
  for (const id of created) {
    try {
      const d = await fetch(`${base}${R.artifact(id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${pat}` },
      });
      if (d.status !== 204)
        console.warn(`smoke cleanup: DELETE ${id} -> ${d.status}`);
    } catch (e) {
      console.warn(`smoke cleanup: DELETE ${id} failed`, e);
    }
  }
});

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
    created.push(id);

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
