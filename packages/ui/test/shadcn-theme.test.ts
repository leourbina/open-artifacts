import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

const dir = `${import.meta.dirname}/../src`;
const themePath = `${dir}/shadcn/theme.css`;
const theme = readFileSync(themePath, "utf8");
const tokensCss = readFileSync(`${dir}/tokens/tokens.css`, "utf8");

// Theme minus comments, so prose can't satisfy or break a check.
const code = theme.replace(/\/\*[\s\S]*?\*\//g, "");
const defined = (css: string) =>
  new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

// What shadcn's new-york (Tailwind v4) components and theme expect.
const SHADCN_VARS = [
  "radius",
  ...[
    "background",
    "foreground",
    "card",
    "card-foreground",
    "popover",
    "popover-foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "destructive",
    "destructive-foreground",
    "border",
    "input",
    "ring",
    "chart-1",
    "chart-2",
    "chart-3",
    "chart-4",
    "chart-5",
    "sidebar",
    "sidebar-foreground",
    "sidebar-primary",
    "sidebar-primary-foreground",
    "sidebar-accent",
    "sidebar-accent-foreground",
    "sidebar-border",
    "sidebar-ring",
    // Ours: the Studio accent for state marks.
    "brand",
    "brand-foreground",
    "brand-soft",
    "brand-soft-foreground",
  ],
];

describe("shadcn theme.css", () => {
  it("references only --oa-* tokens that tokens.css defines", () => {
    const tokens = defined(tokensCss);
    const used = new Set(
      [...code.matchAll(/var\((--oa-[\w-]+)\)/g)].map((m) => m[1]),
    );
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((v) => !tokens.has(v))).toEqual([]);
  });

  it("defines every variable shadcn expects, plus its @theme colors", () => {
    const vars = defined(code);
    expect(SHADCN_VARS.filter((v) => !vars.has(`--${v}`))).toEqual([]);
    const colors = SHADCN_VARS.filter((v) => v !== "radius").map(
      (v) => `--color-${v}`,
    );
    expect(colors.filter((v) => !vars.has(v))).toEqual([]);
  });

  it("has no color literals and no per-theme redefinitions", () => {
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b|oklch\(|rgba?\(|hsla?\(/i);
    // Exactly one rule sets shadcn's variables; dark comes from tokens.css.
    expect(code.match(/--background\s*:/g)).toHaveLength(1);
  });

  it("compiles with Tailwind and themes the shadcn utilities", async () => {
    // CSS packages resolve through their "style" export, as bundlers do.
    const resolveCss = (id: string) => {
      // Direct deps of @oa/ui are linked under its node_modules.
      const pkg = resolve(dir, "../node_modules", id, "package.json");
      const { exports, style } = JSON.parse(readFileSync(pkg, "utf8"));
      return resolve(dirname(pkg), exports?.["."]?.style ?? style);
    };
    const loadStylesheet = async (id: string, base: string) => {
      const path = id.startsWith(".") ? resolve(base, id) : resolveCss(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    };
    const compiler = await compile(theme, {
      base: dirname(themePath),
      from: themePath,
      loadStylesheet,
    });
    const css = compiler.build([
      "bg-background",
      "text-primary-foreground",
      "border-input",
      "ring-ring",
      "rounded-md",
      "dark:bg-card",
      "bg-brand",
      "text-brand-foreground",
      "animate-in",
    ]);
    // @theme inline: utilities point straight at shadcn's vars and our tokens.
    expect(css).toMatch(/\.bg-background\s*\{[^}]*var\(--background\)/);
    expect(css).toMatch(/\.bg-brand\s*\{[^}]*var\(--brand\)/);
    expect(css).toMatch(/\.rounded-md\s*\{[^}]*var\(--oa-radius-md\)/);
    expect(css).toMatch(
      /:root, \[data-theme\] \{[^}]*--background: var\(--oa-bg\)/,
    );
    expect(css).not.toContain("@import url(");
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toMatch(/\.animate-in/);
  });
});

describe("main entry", () => {
  it("doesn't import anything shadcn", () => {
    const index = readFileSync(`${dir}/index.ts`, "utf8");
    expect(index).not.toMatch(/shadcn|tailwind|lucide|class-variance|clsx/);
  });
});
