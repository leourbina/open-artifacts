// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import axe from "axe-core";
import { createRef } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Avatar,
  avatarHue,
  Button,
  IconButton,
  Kbd,
  Spinner,
  Tooltip,
  tokens,
} from "../src/index";

afterEach(cleanup);
const icon = <svg aria-hidden="true" />;

function lum([r, g, b]: number[]) {
  const f = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const hex = (h: string) =>
  [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const [AVATAR_S, AVATAR_L] = (() => {
  const css = readFileSync(
    `${import.meta.dirname}/../src/components/Display.module.css`,
    "utf8",
  );
  const m = /hsl\(var\(--hue\) (\d+)% (\d+)%\)/.exec(css);
  if (!m) throw new Error("avatar background not found");
  return [Number(m[1]) / 100, Number(m[2]) / 100];
})();
function hsl(h: number, s: number, l: number) {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(
    (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)),
  );
}

describe("adversarial D3", () => {
  it("IconButton rejects a whitespace-only label", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<IconButton label="   " icon={icon} />)).toThrow(
      /label/,
    );
    spy.mockRestore();
  });

  it("Avatar initials never split a surrogate pair (emoji name)", () => {
    const { container } = render(<Avatar name="😀 Bob" email="b@x.io" />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it("Avatar email-derived initials contain no '@' or whitespace", () => {
    const a = render(<Avatar email="a@x.io" />).container.textContent ?? "";
    const b = render(<Avatar email=" ada@x.io" />).container.textContent ?? "";
    expect(a).not.toMatch(/@/);
    expect(b).not.toMatch(/\s/);
  });

  it("Avatar with whitespace-only name has a non-blank accessible name", () => {
    const { getByRole } = render(<Avatar name="  " email="ada@x.io" />);
    expect(getByRole("img").getAttribute("aria-label")?.trim()).toBeTruthy();
  });

  it("Avatar hue is stable across Unicode normalization forms", () => {
    expect(avatarHue("josé@x.io")).toBe(avatarHue("josé@x.io"));
  });

  it("Avatar white initials meet 4.5:1 at every hue (CSS lightness)", () => {
    const failing = [];
    for (let h = 0; h < 360; h++) {
      const r = ratio([1, 1, 1], hsl(h, AVATAR_S, AVATAR_L));
      if (r < 4.5) failing.push(`${h}:${r.toFixed(2)}`);
    }
    expect(failing).toEqual([]);
  });

  it("Spinner with empty label still has an accessible name", async () => {
    const { container } = render(
      <main>
        <Spinner label="" />
      </main>,
    );
    const res = await axe.run(container);
    expect(
      container.querySelector('[role="status"]')?.getAttribute("aria-label"),
    ).toBeTruthy();
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });

  it("badge/ghost token pairs meet 4.5:1 in both themes", () => {
    const pairs = [
      ["text-2", "sunken"],
      ["accent-fg", "accent-soft"],
      ["text-muted", "surface-2"],
      ["warning", "warning-soft"],
    ];
    const bad: string[] = [];
    for (const t of ["light", "dark"] as const)
      for (const [f, b] of pairs) {
        const r = ratio(hex(tokens[f][t]), hex(tokens[b][t]));
        if (r < 4.5) bad.push(`${t} ${f}/${b} ${r.toFixed(2)}`);
      }
    expect(bad).toEqual([]);
  });

  it("forwards refs (React 19 ref-as-prop)", () => {
    const b = createRef<HTMLButtonElement>();
    const ib = createRef<HTMLButtonElement>();
    const k = createRef<HTMLElement>();
    render(
      <>
        <Button ref={b}>x</Button>
        <IconButton ref={ib} label="y" icon={icon} />
        <Kbd ref={k}>K</Kbd>
      </>,
    );
    expect(b.current?.tagName).toBe("BUTTON");
    expect(ib.current?.tagName).toBe("BUTTON");
    expect(k.current?.tagName).toBe("KBD");
  });

  it("loading Button cannot be clicked and is aria-busy", () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    fireEvent.click(getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
    expect(getByRole("button").getAttribute("aria-busy")).toBe("true");
  });

  it("loading cannot be overridden by a caller aria-busy={false}", () => {
    const { getByRole } = render(
      <Button loading aria-busy={false}>
        Save
      </Button>,
    );
    expect(getByRole("button").getAttribute("aria-busy")).toBe("true");
  });

  it("Button defaults to type=button inside a form", () => {
    const { getByRole } = render(
      <form>
        <Button>x</Button>
      </form>,
    );
    expect(getByRole("button").getAttribute("type")).toBe("button");
  });

  it("Tooltip opens on keyboard focus", async () => {
    const { getByRole, findByRole } = render(
      <Tooltip content="Hint">
        <button type="button">t</button>
      </Tooltip>,
    );
    await act(async () => {
      getByRole("button").focus();
    });
    expect(await findByRole("tooltip")).toBeTruthy();
  });

  it("SSR renders without throwing", () => {
    expect(() =>
      renderToString(
        <>
          <IconButton label="a" icon={icon} />
          <Avatar email="a@x.io" />
          <Spinner />
        </>,
      ),
    ).not.toThrow();
  });
});
