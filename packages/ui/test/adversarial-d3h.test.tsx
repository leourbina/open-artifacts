// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs } from "../src/index";

afterEach(cleanup);

const after = <button type="button">After</button>;
async function tabFrom(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name }));
  await user.tab();
  return document.activeElement;
}

describe("adversarial D3 tabs nav", () => {
  const mixed = [
    { id: "a", label: "A", content: null },
    { id: "b", label: "B", content: "Body B" },
  ];

  it("mixed: null tab adds no stop, content tab's panel is a stop, and back again", async () => {
    render(
      <>
        <Tabs tabs={mixed} />
        {after}
      </>,
    );
    expect(await tabFrom("A")).toBe(
      screen.getByRole("button", { name: "After" }),
    );
    expect(await tabFrom("B")).toBe(screen.getByRole("tabpanel"));
    expect(screen.getByRole("tabpanel").getAttribute("tabindex")).toBe("0");
    expect(await tabFrom("A")).toBe(
      screen.getByRole("button", { name: "After" }),
    );
  });

  it("controlled value switching keeps tab stops right", async () => {
    function C() {
      const [v, setV] = useState("a");
      return (
        <>
          <Tabs tabs={mixed} value={v} onValueChange={setV} />
          {after}
        </>
      );
    }
    render(<C />);
    expect(await tabFrom("B")).toBe(screen.getByRole("tabpanel"));
    expect(await tabFrom("A")).toBe(
      screen.getByRole("button", { name: "After" }),
    );
  });

  it("axe passes with either tab active", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <main>
        <Tabs tabs={mixed} />
      </main>,
    );
    expect((await axe.run(container)).violations.map((v) => v.id)).toEqual([]);
    await user.click(screen.getByRole("tab", { name: "B" }));
    expect((await axe.run(container)).violations.map((v) => v.id)).toEqual([]);
  });

  const empties: [string, ReactNode][] = [
    ["false", false],
    ["empty string", ""],
    ["true", true],
  ];
  for (const [n, content] of empties)
    it(`content ${n} renders nothing, so adds no tab stop`, async () => {
      render(
        <>
          <Tabs tabs={[{ id: "a", label: "A", content }]} />
          {after}
        </>,
      );
      expect(await tabFrom("A")).toBe(
        screen.getByRole("button", { name: "After" }),
      );
    });

  it("content 0 renders '0', so its panel stays a tab stop", async () => {
    render(
      <>
        <Tabs tabs={[{ id: "a", label: "A", content: 0 }]} />
        {after}
      </>,
    );
    expect(await tabFrom("A")).toBe(screen.getByRole("tabpanel"));
  });
});
