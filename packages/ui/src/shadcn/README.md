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

From `packages/ui`:

```sh
pnpm dlx shadcn@4.22.1 add <name>
```

`components.json` sends files to `src/shadcn/ui/` through the package imports
in `package.json` (`#shadcn/ui/*`, `#shadcn/lib/*`, …). Components import `cn`
from the `cn` package, per shadcn's 2026-09 change. `lib/utils.ts` re-exports
it.

## Theme mapping

`theme.css` defines shadcn's variables as references to `--oa-*` tokens, so
`packages/ui/src/tokens/tokens.css` stays the single source of color. Dark mode
comes from the tokens switching (by `prefers-color-scheme` or `data-theme`);
nothing is redefined per theme. The `dark:` variant follows the same rule.

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
| `--destructive-foreground` | `--oa-bg` | |
| `--border` | `--oa-divider` | |
| `--input` | `--oa-border-strong` | ≥ 3:1 for control boundaries |
| `--ring` | `--oa-focus` | |
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

The variables are declared on `:root` and on every `[data-theme]` element, so a
nested theme wrapper resolves them against its own tokens.
