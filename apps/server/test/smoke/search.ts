import {
  PageSchema,
  PublishResultSchema,
  R,
  SearchHitSchema,
} from "@oa/shared";
import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;

describe.skipIf(!base || !pat)("staging smoke: search", () => {
  it("publishes, then finds it by a body word (indexing runs in waitUntil)", async () => {
    const word = `smokesearch${Date.now().toString(36)}`;
    const r = await fetch(`${base}${R.artifacts}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "smoke search",
        format: "html",
        content: `<script>hidden()</script><p>${word}</p>`,
      }),
    });
    expect(r.status).toBe(201);
    const { id } = PublishResultSchema.parse(await r.json());
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      const s = await fetch(`${base}${R.search}?q=${word}`, {
        headers: { authorization: `Bearer ${pat}` },
      });
      expect(s.status).toBe(200);
      const page = PageSchema(SearchHitSchema).parse(await s.json());
      found = page.items.some((h) => h.id === id);
      if (!found) await new Promise((res) => setTimeout(res, 500));
    }
    expect(found).toBe(true);
    const anon = await fetch(`${base}${R.search}?q=${word}`);
    expect(anon.status).toBe(401);
  });
});
