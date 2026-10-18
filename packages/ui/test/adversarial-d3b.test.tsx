// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, Spinner } from "../src/index";

afterEach(cleanup);

describe("adversarial D3 round 2", () => {
  it("Avatar initials keep a whole grapheme (ZWJ emoji, combining accent)", () => {
    const a = render(<Avatar name="👩‍💻 Ada" email="a@x.io" />).container
      .textContent;
    const b = render(<Avatar name={"Émile Zola"} email="e@x.io" />).container
      .textContent;
    expect(a).toBe("👩‍💻A");
    expect(b?.normalize("NFC")).toBe("ÉZ");
  });

  it("Avatar initials stay at most 2 characters (ß uppercases to SS)", () => {
    const t = render(<Avatar email="ßa@x.io" />).container.textContent ?? "";
    expect([...t].length).toBeLessThanOrEqual(2);
  });

  it("Avatar with blank email and no name still has an accessible name", () => {
    const { getByRole } = render(<Avatar email="  " />);
    expect(getByRole("img").getAttribute("aria-label")?.trim()).toBeTruthy();
  });

  it("Spinner with whitespace label still has an accessible name", () => {
    const { getByRole } = render(<Spinner label="  " />);
    expect(getByRole("status").getAttribute("aria-label")?.trim()).toBeTruthy();
  });
});
