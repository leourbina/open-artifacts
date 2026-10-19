// Adversarial checks on the shadcn foundation (PR #190). Each test encodes a
// finding reproduced with `pnpm dlx shadcn@4.22.1 add button sidebar dialog
// sonner select tabs chart` and a Vite + @tailwindcss/vite page in Chromium.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = `${import.meta.dirname}/..`;
const root = `${pkg}/../..`;
const theme = readFileSync(`${pkg}/src/shadcn/theme.css`, "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const tokens = readFileSync(`${pkg}/src/tokens/tokens.css`, "utf8");
const readme = readFileSync(`${pkg}/src/shadcn/README.md`, "utf8");

const hex = (s: string) =>
  [1, 3, 5].map((i) => Number.parseInt(s.slice(i, i + 2), 16));
const lum = (rgb: number[]) => {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const darkToken = (name: string) => {
  const block = tokens.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  const m = block?.[1].match(new RegExp(`--oa-${name}:\\s*(#[0-9a-f]{6})`));
  if (!m) throw new Error(`no dark --oa-${name}`);
  return m[1];
};

describe("shadcn foundation: adversarial", () => {
  // Fixed by routing the CLI's CSS to a sink: `shadcn add sidebar` appended
  // neutral :root/.dark blocks to theme.css that overrode the Studio mapping.
  it("sends the CLI's CSS to the sink, never to theme.css", () => {
    const config = JSON.parse(readFileSync(`${pkg}/components.json`, "utf8"));
    expect(config.tailwind.css).toBe("src/shadcn/cli-sink.css");
    const sinkUsers = [
      theme,
      readFileSync(`${pkg}/src/shadcn/shadcn.css`, "utf8"),
      readFileSync(`${pkg}/src/shadcn/shadcn-utilities.css`, "utf8"),
      readFileSync(`${pkg}/src/shadcn/index.ts`, "utf8"),
    ];
    for (const src of sinkUsers) expect(src).not.toContain("cli-sink");
  });

  it("theme.css colors are only var(--oa-*) references", () => {
    expect(theme).not.toMatch(/hsla?\(|oklch\(|rgba?\(|#[0-9a-f]{3,8}\b/i);
    for (const [, value] of theme.matchAll(/--[\w-]+:\s*([^;]+);/g))
      if (!/^var\(--/.test(value) && !/calc|color-mix/.test(value))
        throw new Error(`non-token value: ${value}`);
  });

  // new-york's destructive button/badge used text-white (2.47:1 on dark
  // --oa-danger); they now use --destructive-foreground, which must hold
  // 4.5:1 in both themes. (Hover states: shadcn-core.test.tsx.)
  it("destructive-foreground is ≥ 4.5:1 on --oa-danger", () => {
    const fg = /--destructive-foreground:\s*var\(--oa-([\w-]+)\)/.exec(
      theme,
    )?.[1] as string;
    expect(fg).toBeDefined();
    expect(readme).toMatch(/text-white/);
    expect(
      contrast(hex(darkToken(fg)), hex(darkToken("danger"))),
    ).toBeGreaterThanOrEqual(4.5);
    const light = (name: string) =>
      tokens.match(
        new RegExp(`--oa-${name}:\\s*(#[0-9a-f]{6})`),
      )?.[1] as string;
    expect(
      contrast(hex(light(fg)), hex(light("danger"))),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("dark: variant and the tokens agree on nested data-theme wrappers", () => {
    // The variant matches `[data-theme="dark"] *` anywhere, but tokens.css only
    // switches on :root. Measured: inside <div data-theme="dark"> on a light
    // page, dark:bg-black applies while bg-primary stays light ink; the reverse
    // for a nested light wrapper under OS dark. README claims nested works.
    const variantNested = /&:where\(\[data-theme="dark"\]/.test(theme);
    const tokensNested = /(^|[\s,}])\[data-theme="dark"\]\s*[,{]/.test(tokens);
    expect(variantNested).toBe(tokensNested);

    // The prefers-color-scheme branch must be root-scoped the same way as
    // tokens.css's media rule, not match a nested data-theme="light".
    const variant = theme.slice(
      theme.indexOf("@custom-variant dark"),
      theme.indexOf("\n}\n", theme.indexOf("@custom-variant dark")),
    );
    const media = variant.slice(variant.indexOf("@media"));
    const rootNotLight = ':root:not([data-theme="light"])';
    expect(media).toContain("prefers-color-scheme: dark");
    expect(media).toContain(rootNotLight);
    expect(media.split(rootNotLight).join("")).not.toContain("data-theme");
    expect(tokens).toContain(`${rootNotLight} {`);
  });

  it("documents data-theme wiring for sonner and chart (they assume .dark)", () => {
    // Generated sonner.tsx calls next-themes useTheme(); with no provider it
    // falls back to "system" and ignores data-theme. chart.tsx scopes its dark
    // colors to `.dark`, which nothing here sets.
    expect(readme).toMatch(/next-themes/);
    expect(readme).toMatch(/\.dark\b/);
  });

  // `add sonner chart` wrote "^" ranges. pnpm shadcn:add pins them; this
  // keeps every runtime dependency of @oa/ui exact (radix-ui included).
  it("pins every @oa/ui dependency exactly", () => {
    const deps = JSON.parse(readFileSync(`${pkg}/package.json`, "utf8"))
      .dependencies as Record<string, string>;
    const ranges = Object.entries(deps).filter(
      ([, v]) => !/^\d+\.\d+\.\d+$/.test(v),
    );
    expect(ranges).toEqual([]);
    expect(deps["radix-ui"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // pnpm shadcn:add runs `biome check --write`; the result must then pass.
  it("generated components pass `biome check` after the add script formats them", () => {
    // Verbatim hooks/use-mobile.ts from `add sidebar`. Every generated file
    // fails the repo lint (format, useImportType, noDangerouslySetInnerHtml in
    // chart.tsx), so the first `shadcn add` breaks `pnpm lint`.
    const generated = `import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(\`(max-width: \${MOBILE_BREAKPOINT - 1}px)\`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
`;
    // A real file under src/shadcn (stdin mode always reports "not fixed").
    const dir = mkdtempSync(`${pkg}/src/shadcn/probe-`);
    const file = `${dir}/use-mobile.ts`;
    const biome = (...args: string[]) =>
      execFileSync(`${root}/node_modules/.bin/biome`, [...args, file], {
        cwd: root,
        stdio: "pipe",
      });
    try {
      writeFileSync(file, generated);
      biome("check", "--write");
      expect(() => biome("check")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
