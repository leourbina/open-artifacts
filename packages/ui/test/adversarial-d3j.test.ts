import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tokens } from "../src/index";

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const css = readFileSync(
  `${import.meta.dirname}/../src/components/Field.module.css`,
  "utf8",
);
const themes = ["light", "dark"] as const;
const tok = (n: string, t: (typeof themes)[number]) => tokens[n]?.[t] as string;

// Every border / border-color on a control boundary, in any state.
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(
  (m) => [(m[1] as string).trim(), m[2] as string] as const,
);
const controlRule = /^\.(control|seg|switch|checkbox)\b/;

describe("adversarial D3 field contrast", () => {
  it("no control border uses a raw color or a non-token value", () => {
    const bad = rules
      .filter(([sel]) => sel.split(",").some((s) => controlRule.test(s.trim())))
      .flatMap(([sel, body]) =>
        [...body.matchAll(/border(?:-color)?\s*:\s*([^;]+);/g)]
          .map((m) => m[1] as string)
          .filter((v) => !/var\(--oa-[\w-]+\)/.test(v) || /#|rgb|hsl/.test(v))
          .map((v) => `${sel}: ${v}`),
      );
    expect(bad).toEqual([]);
  });

  it("every enabled control border state is >= 3:1 on bg, surface, surface-2", () => {
    const fails: string[] = [];
    for (const [sel, body] of rules) {
      if (!sel.split(",").some((s) => controlRule.test(s.trim()))) continue;
      if (/:disabled/.test(sel)) continue;
      for (const m of body.matchAll(
        /border(?:-color)?\s*:[^;]*var\(--oa-([\w-]+)\)/g,
      ))
        for (const t of themes)
          for (const bg of ["bg", "surface", "surface-2"]) {
            const r = contrast(tok(m[1] as string, t), tok(bg, t));
            if (r < 3)
              fails.push(`${sel} ${m[1]} on ${bg} (${t}) ${r.toFixed(2)}`);
          }
    }
    expect(fails).toEqual([]);
  });

  // Updated with the fix: the thumb and track tokens are read from the CSS
  // (was hard-coded border-strong on sunken, 2.96:1 in light).
  it("unchecked Switch thumb (state indicator) is >= 3:1 on its track", () => {
    const bgOf = (sel: string) =>
      /background:\s*var\(--oa-([\w-]+)\)/.exec(
        rules.find(([s]) => s === sel)?.[1] ?? "",
      )?.[1] as string;
    const track = bgOf(".switch");
    const thumb = bgOf(".thumb");
    for (const t of themes)
      expect(contrast(tok(thumb, t), tok(track, t)), t).toBeGreaterThanOrEqual(
        3,
      );
  });

  it("checked Checkbox check glyph (surface on text) is >= 3:1", () => {
    for (const t of themes)
      expect(
        contrast(tok("surface", t), tok("text", t)),
        t,
      ).toBeGreaterThanOrEqual(3);
  });

  it("selected segment (surface) is distinguishable from the track (surface-2) at 3:1, or has another cue", () => {
    const sel =
      rules.find(([s]) => s.includes('.segItem[aria-checked="true"]'))?.[1] ??
      "";
    const hasNonColorCue = /border|outline|font-weight|text-decoration/.test(
      sel,
    );
    for (const t of themes) {
      const r = contrast(tok("surface", t), tok("surface-2", t));
      if (!hasNonColorCue)
        expect(r, `${t} surface vs surface-2`).toBeGreaterThanOrEqual(3);
    }
  });
});
