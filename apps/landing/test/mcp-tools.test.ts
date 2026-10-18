import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublishInputSchema } from "@oa/shared";
import { describe, expect, it } from "vitest";

// The publish_artifact table must list exactly the schema's fields.
const doc = readFileSync(
  fileURLToPath(new URL("../src/content/docs/mcp-tools.md", import.meta.url)),
  "utf8",
);

describe("mcp-tools docs", () => {
  it("describes the upload flow and search lag", () => {
    const large = doc.split("## Large files")[1]?.split("\n## ")[0] ?? "";
    for (const word of [
      "`create_upload`",
      "`uploadId`",
      "`PUT`",
      "`publish_artifact`",
    ])
      expect(large).toContain(word);
    expect(doc).toMatch(/search_artifacts[^.]*few seconds/);
    expect(doc).toContain("search matches the previous version's text");
    // The 413 message isn't quoted: {LIMIT_INLINE} carries the number.
    expect(doc).not.toMatch(/Inline content is limited to/);
  });

  it("documents every PublishInputSchema field, and no others", () => {
    const table = doc.split("## Publishing")[1]?.split("\n## ")[0] ?? "";
    const rows = [...table.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map(
      ([, k]) => k,
    );
    expect(new Set(rows)).toEqual(
      new Set(Object.keys(PublishInputSchema.shape)),
    );
  });
});
