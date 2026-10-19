import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom has no layout, so assert the rule itself: a width:100% control must
// count its padding and border, or it overflows the card it sits in.
const css = readFileSync(
  `${import.meta.dirname}/../src/components/Field.module.css`,
  "utf8",
);

describe("Field sizing", () => {
  it("makes .control border-box", () => {
    const block = css.match(/\.control\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/width:\s*100%/);
    expect(block).toMatch(/box-sizing:\s*border-box/);
  });
});
