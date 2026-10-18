import { ContentUrlSchema, PublishResultSchema, R } from "@oa/shared";
import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;
const CSP_SANDBOX =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors ";

describe.skipIf(!base || !pat)("staging smoke: content host", () => {
  it("serves a signed content URL in the sandbox; expired token → 404", async () => {
    const auth = { authorization: `Bearer ${pat}` };
    const r = await fetch(`${base}${R.artifacts}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        title: `smoke content ${new Date().toISOString()}`,
        format: "html",
        content: "<!doctype html><h1>smoke content</h1>",
      }),
    });
    expect(r.status).toBe(201);
    const { id } = PublishResultSchema.parse(await r.json());

    const cu = await fetch(`${base}${R.contentUrl(id)}`, { headers: auth });
    expect(cu.status).toBe(200);
    const { url, expiresAt } = ContentUrlSchema.parse(await cu.json());
    expect(expiresAt).not.toBeNull();

    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp.startsWith(CSP_SANDBOX)).toBe(true);
    expect(csp).not.toContain("allow-same-origin");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("smoke content");

    const expired = url.replace(
      /\/c\/(\d+)\./,
      (_, exp: string) => `/c/${Number(exp) - 3600}.`,
    );
    const gone = await fetch(expired, { redirect: "manual" });
    expect(gone.status).toBe(404);
    expect(gone.headers.get("content-security-policy")).toBe(csp);
  });
});
