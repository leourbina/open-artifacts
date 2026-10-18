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
