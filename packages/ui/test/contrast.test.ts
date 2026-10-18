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
