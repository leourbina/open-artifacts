// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import axe from "axe-core";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../src/shadcn";
import { tokens } from "../src/tokens/index";

// jsdom has no ResizeObserver; Radix's popper (open tooltip) needs one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

const cases: Record<string, ReactElement> = {
  Button: <Button>Save</Button>,
  ButtonDestructive: <Button variant="destructive">Delete</Button>,
  Input: <Input aria-label="Title" />,
  Label: (
    <>
      <Label htmlFor="t">Title</Label>
      <Input id="t" />
    </>
  ),
  Card: (
    <Card>
      <CardHeader>
        <CardTitle>Q4 plan</CardTitle>
        <CardDescription>Markdown · 2h ago</CardDescription>
      </CardHeader>
      <CardContent>Body</CardContent>
    </Card>
  ),
  Badge: <Badge>Team</Badge>,
  BadgeDestructive: <Badge variant="destructive">Failed</Badge>,
  Avatar: (
    <Avatar>
      <AvatarFallback>MC</AvatarFallback>
    </Avatar>
  ),
  Tooltip: (
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger>Hover</TooltipTrigger>
        <TooltipContent>Hint</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
  Skeleton: <Skeleton className="h-4 w-24" />,
  Separator: <Separator />,
};

describe.each(["light", "dark"])("shadcn core a11y (%s)", (theme) => {
  for (const [name, el] of Object.entries(cases)) {
    it(`${name} has no axe violations`, async () => {
      document.documentElement.dataset.theme = theme;
      render(<main>{el}</main>);
      // Portals (tooltip) land outside <main>; that's the app shell's concern.
      const result = await axe.run(document.body, {
        rules: { region: { enabled: false } },
      });
      expect(result.violations.map((v) => v.id)).toEqual([]);
    });
  }
});

// WCAG contrast of 6-digit hex colors, with alpha blending for `/90`.
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number)
  );
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
};
const over = (fg: number[], bg: number[], alpha: number) =>
  fg.map((v, i) => alpha * v + (1 - alpha) * (bg[i] as number));

describe("destructive variants", () => {
  const theme = readFileSync(
    `${import.meta.dirname}/../src/shadcn/theme.css`,
    "utf8",
  );
  const fgToken = /--destructive-foreground:\s*var\(--oa-([\w-]+)\)/.exec(
    theme,
  )?.[1] as string;

  it("use destructive-foreground on a full destructive fill", () => {
    for (const el of [
      <Button key="b" variant="destructive">
        x
      </Button>,
      <Badge key="g" variant="destructive">
        x
      </Badge>,
    ]) {
      const { container } = render(el);
      const cls = (container.firstElementChild as Element).className;
      expect(cls).toContain("text-destructive-foreground");
      expect(cls).not.toContain("text-white");
      expect(cls).not.toContain("dark:bg-destructive/");
      cleanup();
    }
  });

  it.each(["light", "dark"] as const)(
    "text is >= 4.5:1, also at the /90 hover (%s)",
    (t) => {
      const fg = rgb(tokens[fgToken]?.[t] as string);
      const danger = rgb(tokens.danger?.[t] as string);
      expect(contrast(fg, danger)).toBeGreaterThanOrEqual(4.5);
      for (const page of ["bg", "surface"]) {
        const hover = over(danger, rgb(tokens[page]?.[t] as string), 0.9);
        expect(contrast(fg, hover), `hover on ${page}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    },
  );
});

describe("Button", () => {
  it("default variant is primary (ink) and focus uses ring", () => {
    const cls = buttonVariants();
    expect(cls).toContain("bg-primary");
    expect(cls).toContain("text-primary-foreground");
    expect(cls).toMatch(/focus-visible:ring-ring\b/);
    const theme = readFileSync(
      `${import.meta.dirname}/../src/shadcn/theme.css`,
      "utf8",
    );
    expect(theme).toMatch(/--primary:\s*var\(--oa-text\)/);
    expect(theme).toMatch(/--ring:\s*var\(--oa-focus\)/);
    expect(tokens.focus?.light).toBe("#2350D0");
  });
});
