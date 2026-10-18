// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, avatarHue, displayName } from "../src/index";

afterEach(cleanup);

const hueOf = (el: HTMLElement) => el.style.getPropertyValue("--hue");

describe("Avatar with a nullable email", () => {
  it("null email with a name: initials and hue from the name", () => {
    render(<Avatar name="Ada Lovelace" email={null} />);
    const el = screen.getByRole("img", { name: "Ada Lovelace" });
    expect(el.textContent).toBe("AL");
    expect(hueOf(el)).toBe(String(avatarHue("Ada Lovelace")));
  });

  it("no name and no email: neutral, '?', labelled Unknown", () => {
    render(<Avatar email={null} />);
    const el = screen.getByRole("img", { name: "Unknown" });
    expect(el.textContent).toBe("?");
    expect(hueOf(el)).toBe("");
  });

  it("existing emails keep their hue", () => {
    render(<Avatar name="Ada" email="ada@example.com" />);
    expect(hueOf(screen.getByRole("img"))).toBe(
      String(avatarHue("ada@example.com")),
    );
  });

  it("has no axe violations in every variant", async () => {
    const { container } = render(
      <main>
        <Avatar name="Ada" email={null} />
        <Avatar email={null} />
        <Avatar email="ada@example.com" />
      </main>,
    );
    const result = await axe.run(container);
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("displayName", () => {
  it("prefers the name, then the email, then Unknown", () => {
    expect(displayName({ name: " Ada ", email: "a@x.io" })).toBe("Ada");
    expect(displayName({ name: "  ", email: "a@x.io" })).toBe("a@x.io");
    expect(displayName({ name: null, email: null })).toBe("Unknown");
    expect(displayName({})).toBe("Unknown");
  });
});
