import { env } from "cloudflare:workers";
import { INLINE_TOO_LARGE_MESSAGE, LIMITS, newId, R } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ApiError } from "../src/http/errors.js";
import { planFiles } from "../src/services/manifest.js";
import { api, errOf, login } from "./helpers.js";

const app = createApp();
let owner: { cookie: string; userId: string };

// Hostile paths (F2, paths.test.ts in @oa/shared).
const HOSTILE = [
  "",
  ".",
  "/etc/passwd",
  "../x",
  "a/../../b",
  "a/..",
  "a\\b",
  "a//b",
  "a/",
  "a\u0000b",
  "a\x7fb",
  "a‮b",
  "x".repeat(513),
];

beforeAll(async () => {
  owner = await login(`paths-${newId().slice(0, 6).toLowerCase()}@x.com`);
});

afterEach(async () => {
  expect((await env.FILES.list()).objects).toHaveLength(0);
});

const post = (body: unknown) =>
  api(app, R.artifacts, owner.cookie, { method: "POST", body });

describe("publish path validation (Review Focus #2)", () => {
  for (const p of HOSTILE) {
    it(`rejects ${JSON.stringify(p.slice(0, 16))}`, async () => {
      const r = await post({ title: "t", files: { "ok.txt": "x", [p]: "x" } });
      expect(r.status).toBe(400);
      const e = await errOf(r);
      expect(e.code).toBe("bad_request");
      expect(e.details).toMatchObject({ path: p });
    });
  }

  it("rejects a hostile entry", async () => {
    const r = await post({
      title: "t",
      format: "html",
      content: "x",
      entry: "../a.html",
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({ path: "../a.html" });
  });

  it("case-only duplicates → 400", async () => {
    const r = await post({ title: "t", files: { "A.css": "x", "a.css": "y" } });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({
      reason: "case_collision",
    });
  });

  it("normalized duplicates → 400", async () => {
    const r = await post({
      title: "t",
      files: { "a.css": "x", "./a.css": "y" },
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({ reason: "duplicate" });
  });

  it("entry missing from files → 400", async () => {
    const r = await post({
      title: "t",
      files: { "a.html": "x" },
      entry: "b.html",
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({
      path: "b.html",
      reason: "missing_entry",
    });
  });

  it("1,001 files → 400", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= LIMITS.filesPerVersion; i++) files[`f${i}.txt`] = "x";
    const r = await post({ title: "t", files });
    expect(r.status).toBe(400);
  });

  it("256 KB + 1 byte inline content → 413 with the upload hint", async () => {
    expect(LIMITS.inlineBytes).toBe(256 * 1024);
    const r = await post({
      title: "t",
      format: "markdown",
      content: "x".repeat(LIMITS.inlineBytes + 1),
    });
    expect(r.status).toBe(413);
    const e = await errOf(r);
    expect(e.code).toBe("too_large");
    expect(e.message).toBe(
      "Inline content is limited to 256 KB. Use create_upload for larger files, then publish with {uploadId}.",
    );
  });

  it("a body past the inline-derived cap → 413 with the upload hint", async () => {
    const r = await post({
      title: "t",
      format: "markdown",
      content: "x".repeat(LIMITS.inlineBytes * 3),
    });
    expect(r.status).toBe(413);
    expect((await errOf(r)).message).toBe(INLINE_TOO_LARGE_MESSAGE);
  });

  it("inline files summing past 256 KB → 413", async () => {
    const half = "x".repeat(LIMITS.inlineBytes / 2);
    const r = await post({
      title: "t",
      files: { "a.txt": half, "b.txt": half, "c.txt": "y" },
    });
    expect(r.status).toBe(413);
    const e = await errOf(r);
    expect(e.details).toMatchObject({ path: "c.txt" });
    expect(e.message).toBe(INLINE_TOO_LARGE_MESSAGE);
  });

  it("base64 decoding to 256 KB + 1 → 413", async () => {
    const bytes = new Uint8Array(LIMITS.inlineBytes + 1);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const r = await post({
      title: "t",
      files: { "a.bin": { base64: btoa(s) } },
    });
    expect(r.status).toBe(413);
  });

  it("invalid base64 → 400", async () => {
    const r = await post({ title: "t", files: { "a.bin": { base64: "!!!" } } });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({ path: "a.bin" });
  });
});

describe("planFiles (defensive)", () => {
  it("throws ApiError with {path, reason} without the schema", () => {
    try {
      planFiles({ title: "t", files: { "../x": "y" } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).details).toEqual({
        path: "../x",
        reason: "traversal",
      });
    }
  });

  it("defaults the entry", () => {
    expect(planFiles({ title: "t", format: "html", content: "x" }).entry).toBe(
      "index.html",
    );
    expect(planFiles({ title: "t", format: "pdf", content: "x" }).entry).toBe(
      "document.pdf",
    );
    expect(
      planFiles({ title: "t", files: { "b.md": "x", "README.md": "y" } }),
    ).toMatchObject({
      entry: "README.md",
      format: "markdown",
    });
  });
});
