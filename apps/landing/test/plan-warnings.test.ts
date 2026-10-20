import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { warnings } from "../../../scripts/setup/src/plan.ts";
import { planWarnings } from "../src/lib/plan-warnings";

// setup.md's plan-warnings table is rendered from scripts/setup at build time;
// these check the built page carries exactly the source's codes and messages.
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const src = read("../src/content/docs/setup.md");
const built = read("../dist/docs/setup.md");
const section = built.split("## Plan warnings")[1]?.split("\n## ")[0] ?? "";
const prereqs = read("../../../scripts/setup/src/steps/prereqs.ts");

describe("plan warnings table", () => {
  it("is a placeholder in the source, never hand-written strings", () => {
    expect(src).toContain("{PLAN_WARNINGS_TABLE}");
    for (const w of warnings("unknown")) expect(src).not.toContain(w.message);
  });

  it("renders every data.warnings code and message from the source, in order", async () => {
    const rows = [...section.matchAll(/^\| `([a-z-]+)` \| (.+) \|$/gm)].map(
      ([, code, message]) => ({ code, message }),
    );
    const want = await planWarnings();
    expect(rows).toEqual(want);
    expect(want.map((w) => w.code)).toEqual([
      ...warnings("unknown").map((w) => w.code),
      "browser-free",
    ]);
  });

  it("matches the free and paid behavior in plan.ts", () => {
    expect(warnings("free").map((w) => w.code)).toEqual(
      warnings("unknown")
        .map((w) => w.code)
        .filter((c) => c !== "plan-unknown"),
    );
    expect(warnings("paid")).toEqual([]);
  });

  it("quotes the Workers Paid message from prereqs", () => {
    const paid = prereqs.match(/ctx\.notes\.unshift\("([^"]+)"\)/)?.[1];
    expect(paid).toBeDefined();
    // prereqs reports ok with a fixed message; the note is data.notes
    expect(section).toContain(
      `the \`prereqs\` line says so in \`data.notes\` ("${paid}")`,
    );
  });
});
