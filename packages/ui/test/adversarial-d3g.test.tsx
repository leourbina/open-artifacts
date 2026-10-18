// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, avatarHue, displayName, tokens } from "../src/index";

afterEach(cleanup);

function lum(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const img = (el: HTMLElement) =>
  el.querySelector('[role="img"]') as HTMLElement;
const blanks = [undefined, null, "", "   "] as const;

describe("adversarial D3 nullable email", () => {
  for (const name of blanks)
    for (const email of blanks)
      it(`blank name=${JSON.stringify(name)} email=${JSON.stringify(email)} is neutral "?" labelled Unknown`, async () => {
        const { container } = render(
          <main>
            <Avatar name={name} email={email} />
          </main>,
        );
        const el = img(container);
        expect(el.getAttribute("aria-label")).toBe("Unknown");
        expect(el.textContent).toBe("?");
        expect(el.style.getPropertyValue("--hue")).toBe("");
        expect(el.className).toMatch(/unknown/);
        expect((await axe.run(container)).violations.map((v) => v.id)).toEqual(
          [],
        );
        expect(displayName({ name, email })).toBe("Unknown");
      });

  it("null email with a name gets a hue from the name and its initials", () => {
    const el = img(
      render(<Avatar name=" Ada Lovelace " email={null} />).container,
    );
    expect(el.style.getPropertyValue("--hue")).toBe(
      String(avatarHue("Ada Lovelace")),
    );
    expect(el.textContent).toBe("AL");
    expect(el.getAttribute("aria-label")).toBe("Ada Lovelace");
    expect(el.className).not.toMatch(/unknown/);
  });

  it("null email + whitespace name renders neutral", () => {
    const el = img(render(<Avatar name={"\t \n"} email={null} />).container);
    expect(el.className).toMatch(/unknown/);
    expect(el.getAttribute("aria-label")).toBe("Unknown");
  });

  it("existing email hues are unchanged (name never affects them)", () => {
    for (const e of ["ada@example.com", " ADA@example.com ", "josé@x.io"]) {
      const a = img(render(<Avatar email={e} />).container);
      const b = img(render(<Avatar name="Someone Else" email={e} />).container);
      expect(a.style.getPropertyValue("--hue")).toBe(String(avatarHue(e)));
      expect(b.style.getPropertyValue("--hue")).toBe(String(avatarHue(e)));
      cleanup();
    }
  });

  it("name-derived hue ignores internal whitespace differences", () => {
    expect(
      img(
        render(<Avatar name="Ada  Lovelace" />).container,
      ).style.getPropertyValue("--hue"),
    ).toBe(
      img(
        render(<Avatar name="Ada Lovelace" />).container,
      ).style.getPropertyValue("--hue"),
    );
  });

  it("neutral avatar text-2 on sunken meets 4.5:1 in both themes", () => {
    for (const t of ["light", "dark"] as const)
      expect(
        ratio(tokens["text-2"][t], tokens.sunken[t]),
        t,
      ).toBeGreaterThanOrEqual(4.5);
  });

  it("displayName prefers trimmed name, then trimmed email", () => {
    expect(displayName({ name: "  ", email: " a@x.io " })).toBe("a@x.io");
    expect(displayName({ name: " Ada ", email: null })).toBe("Ada");
  });
});
