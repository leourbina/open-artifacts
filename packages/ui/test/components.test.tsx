// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, cleanup, render } from "@testing-library/react";
import axe from "axe-core";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Avatar,
  avatarHue,
  Badge,
  Button,
  IconButton,
  Kbd,
  Spinner,
  Tooltip,
  VisibilityBadge,
} from "../src/index";

afterEach(cleanup);

const icon = <svg aria-hidden="true" />;
const noop = () => {};

const cases: Record<string, ReactElement> = {
  Button: <Button variant="primary">Save</Button>,
  ButtonLoading: <Button loading>Save</Button>,
  IconButton: <IconButton label="More" icon={icon} />,
  Badge: <Badge tone="accent">New</Badge>,
  Avatar: <Avatar name="Ada Lovelace" email="ada@example.com" />,
  Kbd: <Kbd>⌘K</Kbd>,
  Spinner: <Spinner />,
  VisibilityBadge: <VisibilityBadge visibility="team" />,
};

describe("components a11y", () => {
  for (const [name, el] of Object.entries(cases)) {
    it(`${name} has no axe violations`, async () => {
      const { container } = render(<main>{el}</main>);
      const result = await axe.run(container);
      expect(result.violations.map((v) => v.id)).toEqual([]);
    });
  }
});

describe("Tooltip a11y", () => {
  it("has no axe violations while open", async () => {
    const { getByRole, findByRole } = render(
      <main>
        <Tooltip content="Hint">
          <button type="button">Hover</button>
        </Tooltip>
      </main>,
    );
    await act(async () => getByRole("button").focus());
    await findByRole("tooltip");
    // Portals land outside landmarks; that is the app shell's concern.
    const result = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("IconButton", () => {
  it("requires label at the type level and at runtime", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(noop);
    // @ts-expect-error label is required
    expect(() => render(<IconButton icon={icon} />)).toThrow(/label/);
    spy.mockRestore();
  });

  it("uses label as the accessible name", () => {
    const { getByRole } = render(<IconButton label="Share" icon={icon} />);
    expect(getByRole("button", { name: "Share" })).toBeTruthy();
  });
});

describe("Avatar hue", () => {
  it("is deterministic per email", () => {
    expect(avatarHue("ada@example.com")).toBe(avatarHue("ada@example.com"));
    expect(avatarHue("ADA@example.com ")).toBe(avatarHue("ada@example.com"));
  });

  it("differs across emails", () => {
    const hues = new Set(
      ["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io", "f@x.io"].map(
        avatarHue,
      ),
    );
    expect(hues.size).toBeGreaterThanOrEqual(5);
  });

  it("renders initials", () => {
    const { getByText } = render(<Avatar name="Ada Lovelace" email="a@x.io" />);
    expect(getByText("AL")).toBeTruthy();
  });

  it("keeps white initials at 4.5:1 or better at every hue", () => {
    const css = readFileSync(
      `${import.meta.dirname}/../src/components/Display.module.css`,
      "utf8",
    );
    const m = /hsl\(var\(--hue\) (\d+)% (\d+)%\)/.exec(css);
    if (!m) throw new Error("avatar background not found");
    const [s, l] = [Number(m[1]) / 100, Number(m[2]) / 100];
    const lin = (c: number) =>
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    for (let h = 0; h < 360; h++) {
      const k = (n: number) => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const [r, g, b] = [0, 8, 4].map((n) =>
        lin(l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))),
      );
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      expect(1.05 / (lum + 0.05), `hue ${h}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
