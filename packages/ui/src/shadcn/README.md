# @oa/ui/shadcn

[shadcn/ui](https://ui.shadcn.com) components (new-york style, Radix via the
`radix-ui` package), themed with the Studio tokens. They live apart from the
CSS-module components exported by `@oa/ui`, which keep their names (`Button`,
`Card`, `Tabs`, …).

```ts
import "@oa/ui/tokens.css"; // first: the --oa-* tokens and the Geist fonts
import "@oa/ui/shadcn.css"; // Tailwind v4 + this theme
import { cn } from "@oa/ui/shadcn";
```

`shadcn.css` imports `tailwindcss`, so it includes Tailwind's preflight reset.
It doesn't `@import` tokens.css itself, because the Google Fonts `@import` in
tokens.css must stay at the top of a stylesheet.

## Adding components

From `packages/ui`, always through the script:

```sh
pnpm shadcn:add <name…>
```

It runs the pinned CLI (`shadcn@4.22.1`), pins any dependency ranges the CLI
saved (`^x` becomes the installed version; a test rejects ranges), and runs
`biome check --write` on `src/shadcn`.

- **Paths.** `components.json` sends files to `src/shadcn/ui/` through the
  package imports in `package.json` (`#shadcn/ui/*`, `#shadcn/lib/*`, …).
  Components import `cn` from the `cn` package, per shadcn's 2026-09 change;
  `lib/utils.ts` re-exports it.
- **CSS.** The CLI's CSS target is `cli-sink.css`, which nothing imports, so
  `add` never edits `theme.css` (it appends neutral `:root`/`.dark` variable
  blocks, e.g. for `sidebar`). The script prints whatever the CLI wrote to
  the sink (new variables, keyframes) and then resets it, so map anything a
  component needs into `theme.css` by hand.
- **Lint.** `packages/ui/biome.jsonc` turns off, for `src/shadcn/ui/**` only,
  the rules shadcn breaks on purpose, each with its reason:
  `noDangerouslySetInnerHtml` (chart's `<style>`), `noDocumentCookie`
  (sidebar state), `noArrayIndexKey` (chart rows) and
  `useExhaustiveDependencies` (sidebar's setter deps).

### Local changes to generated components

- **button, badge:** new-york's destructive variant used `text-white` (2.47:1
  on dark `--oa-danger`) and `dark:bg-destructive/60`. They now use
  `text-destructive-foreground` (`--oa-accent-text`) on a full
  `bg-destructive`: 5.81:1 light, 7.4:1 dark, and at least 4.97:1 at the
  `/90` hover.

- **Focus (button, badge, input):** shadcn's translucent `ring-ring/50` and
  `ring-destructive/20|40` become a solid Studio outline,
  `focus-visible:outline-2 outline-solid outline-offset-2 outline-ring`
  (`--oa-focus`, ≥ 5.88:1 on bg and surface in both themes).
- **Outline button, outline badge, input:** `border-input`
  (`--oa-border-strong`, ≥ 3:1) in both themes, not `border-border`. Input
  drops `dark:bg-input/30`, so its placeholder stays ≥ 4.5:1.

Real-browser checks (axe incl. color-contrast, and every focus outline, in
both themes): `pnpm --filter @oa/ui test:browser` (Playwright Chromium).

### To fix when these components are added
- **sonner:** it reads the theme from `next-themes`' `useTheme()`, which has no
  provider here and ignores `data-theme`. Replace it with a hook that reads
  `<html data-theme>` (and `prefers-color-scheme`), and drop `next-themes`.
- **chart:** it scopes dark colors to `.dark`, which nothing sets. Change its
  `THEMES.dark` selector to ours: `:root[data-theme="dark"]` (plus the
  `prefers-color-scheme` case).

## Theme mapping

`theme.css` defines shadcn's variables as references to `--oa-*` tokens, so
`packages/ui/src/tokens/tokens.css` stays the single source of color. Dark mode
comes from the tokens switching; nothing is redefined per theme.

The theme follows `<html data-theme>` only, like tokens.css: `dark` when
`<html data-theme="dark">`, or when the OS prefers dark and `<html>` isn't
`data-theme="light"`. The `dark:` variant uses the same rule. A `data-theme`
on a nested element doesn't switch the theme.

| shadcn variable | Studio token | Note |
|---|---|---|
| `--background` | `--oa-bg` | |
| `--foreground` | `--oa-text` | |
| `--card`, `--popover` | `--oa-surface` | |
| `--card-foreground`, `--popover-foreground` | `--oa-text` | |
| `--primary` | `--oa-text` | Studio's primary button is ink |
| `--primary-foreground` | `--oa-bg` | |
| `--secondary` | `--oa-surface-2` | |
| `--secondary-foreground` | `--oa-text` | |
| `--muted` | `--oa-sunken` | |
| `--muted-foreground` | `--oa-text-muted` | |
| `--accent` | `--oa-surface-2` | shadcn's hover surface, not our accent |
| `--accent-foreground` | `--oa-text` | |
| `--destructive` | `--oa-danger` | |
| `--destructive-foreground` | `--oa-accent-text` | ≥ 4.5:1 on danger in both themes |
| `--border` | `--oa-divider` | |
| `--input` | `--oa-border-strong` | ≥ 3:1 for control boundaries |
| `--ring` | `--oa-focus` | |
| `--brand` | `--oa-accent` | Ours, not shadcn's: `bg-brand`/`text-brand` for state marks |
| `--brand-foreground` | `--oa-accent-text` | Text on a brand fill |
| `--radius` | `--oa-radius-md` | |
| `--chart-1` … `--chart-5` | `--oa-accent`, `--oa-success`, `--oa-warning`, `--oa-danger`, `--oa-text-muted` | |
| `--sidebar` | `--oa-chrome` | |
| `--sidebar-foreground` | `--oa-text` | |
| `--sidebar-primary` | `--oa-text` | |
| `--sidebar-primary-foreground` | `--oa-bg` | |
| `--sidebar-accent` | `color-mix(in srgb, --oa-text 8%, --oa-chrome)` | |
| `--sidebar-accent-foreground` | `--oa-text` | |
| `--sidebar-border` | `--oa-divider` | |
| `--sidebar-ring` | `--oa-focus` | |

| Tailwind theme | Value |
|---|---|
| `--font-sans`, `--font-mono` | `--oa-font-sans`, `--oa-font-mono` (Geist, Geist Mono) |
| `--radius-sm`, `-md`, `-lg` | `--oa-radius-sm` (4px), `--oa-radius-md` (6px), `--oa-radius-lg` (8px) |
| `--radius-xl` … `-4xl` | multiples of `--oa-radius-lg` |

The variables are declared on `:root`, and also on `[data-theme]` elements so a
wrapper that sets its own `--oa-*` values inline (Ladle's side-by-side light
and dark panels) resolves against them.
