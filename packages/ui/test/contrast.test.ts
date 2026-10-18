import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tokens } from "../src/index";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const pairs: [fg: string, bg: string, min: number][] = [
  ["text", "bg", 4.5],
  ["text", "surface", 4.5],
  ["accent-text", "accent", 4.5],
  ["text-muted", "bg", 4.5],
  ["text-muted", "surface", 4.5],
  ["border", "bg", 1.5],
  ["border-strong", "bg", 3],
  ["border-strong", "surface", 3],
  ["border-strong", "surface-2", 3],
  ["success", "success-soft", 4.5],
  ["success-fg", "success-soft", 4.5],
  ["danger", "danger-soft", 4.5],
  ["warning", "warning-soft", 4.5],
];

describe.each(["light", "dark"] as const)("%s theme", (theme) => {
  it.each(pairs)("%s on %s is at least %s:1", (fg, bg, min) => {
    const a = tokens[fg]?.[theme];
    const b = tokens[bg]?.[theme];
    expect(a, fg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(b, bg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(a as string, b as string)).toBeGreaterThanOrEqual(min);
  });
});

// WCAG 1.4.11: form-control boundaries need 3:1 against what they sit on.
describe("control borders in Field.module.css", () => {
  const css = readFileSync(
    `${import.meta.dirname}/../src/components/Field.module.css`,
    "utf8",
  );
  const borderToken = (selector: string) => {
    const body = new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`).exec(
      css,
    )?.[1];
    return /border:[^;]*var\(--oa-([\w-]+)\)/.exec(body ?? "")?.[1];
  };

  it.each([".control", ".seg"])("%s border is at least 3:1", (selector) => {
    const token = borderToken(selector);
    expect(token, selector).toBeDefined();
    for (const theme of ["light", "dark"] as const)
      for (const bg of ["bg", "surface"]) {
        const ratio = contrast(
          tokens[token as string]?.[theme] as string,
          tokens[bg]?.[theme] as string,
        );
        expect(ratio, `${token} on ${bg} (${theme})`).toBeGreaterThanOrEqual(3);
      }
  });
});

describe("render .oa-error", () => {
  const css = readFileSync(
    `${import.meta.dirname}/../../render/src/theme.css`,
    "utf8",
  );
  const pairs = [
    ...css.matchAll(
      /--oa-error-fg:\s*(#[0-9a-f]{6});\s*--oa-error-bg:\s*(#[0-9a-f]{6})/gi,
    ),
  ].map((m) => [m[1] as string, m[2] as string]);

  it("defines light and both dark variants", () => {
    expect(pairs).toHaveLength(3);
  });

  it("uses the danger tokens", () => {
    const [light, ...dark] = pairs;
    expect(light).toEqual(
      [tokens.danger?.light, tokens["danger-soft"]?.light].map((v) =>
        v?.toLowerCase(),
      ),
    );
    for (const d of dark)
      expect(d).toEqual(
        [tokens.danger?.dark, tokens["danger-soft"]?.dark].map((v) =>
          v?.toLowerCase(),
        ),
      );
  });

  it("keeps danger text at 4.5:1 on its background", () => {
    for (const [fg, bg] of pairs)
      expect(contrast(fg as string, bg as string)).toBeGreaterThanOrEqual(4.5);
  });

  it("paints the page bg behind the error in light and dark", () => {
    const bgFor = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return /background:\s*(#[0-9a-f]{6})/i.exec(css.slice(at))?.[1];
    };
    expect(bgFor(":root:has(.oa-error)")).toBe(tokens.bg?.light.toLowerCase());
    for (const sel of [
      ':root:not([data-theme="light"]):has(.oa-error)',
      ':root[data-theme="dark"]:has(.oa-error)',
    ])
      expect(bgFor(sel)).toBe(tokens.bg?.dark.toLowerCase());
  });
});
