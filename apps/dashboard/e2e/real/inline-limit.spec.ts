/// <reference types="node" />
// The inline publish limit (LIMITS.inlineBytes, 128 KB): an agent's 200 KB HTML
// page is refused inline with the upload steps, then goes through them
// (create_upload, PUT, publish_artifact with uploadId) and renders.
import { LIMITS } from "@oa/shared";
import { artifactFrame, expect, test, uniq } from "./fixtures";
import { mcpWithToken } from "./mcp-client";

/** About `bytes` of HTML with a known heading. */
const page200k = (bytes: number) => {
  const head = '<!doctype html><meta charset="utf-8"><h1 id="t">Big page</h1>';
  const para = "<p>Quarterly figures, by region and by month.</p>\n";
  return head + para.repeat(Math.ceil((bytes - head.length) / para.length));
};

test("an agent's 200 KB HTML page goes through create_upload and renders", async ({
  page,
  member,
}) => {
  const html = page200k(200 * 1024);
  const bytes = new TextEncoder().encode(html);
  expect(bytes.length).toBeGreaterThan(LIMITS.inlineBytes);
  const agent = await mcpWithToken(member.pat);
  try {
    const title = `Big ${uniq()}`;
    // Inline is refused, with the exact next calls.
    const inline = await agent.call("publish_artifact", {
      title,
      format: "html",
      content: html,
    });
    expect(inline.ok).toBe(false);
    expect(inline.text).toContain("too_large");
    expect(inline.text).toContain("create_upload({ path, size, contentType })");
    expect(inline.text).toContain("publish_artifact({ id: artifactId");

    const up = await agent.call("create_upload", {
      path: "index.html",
      size: bytes.length,
      contentType: "text/html",
    });
    expect(up.ok, up.text).toBe(true);
    const { uploadId, url, artifactId } = up.data as {
      uploadId: string;
      url: string;
      artifactId: string;
    };
    const put = await fetch(url, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "text/html" },
    });
    expect(put.status).toBe(204);
    const pub = await agent.call("publish_artifact", {
      id: artifactId,
      title,
      files: { "index.html": { uploadId } },
      entry: "index.html",
    });
    expect(pub.ok, pub.text).toBe(true);
    const id = (pub.data as { id: string }).id;

    await page.goto(`/a/${id}`);
    await expect(artifactFrame(page).locator("#t")).toHaveText("Big page");
  } finally {
    await agent.close();
  }
});
