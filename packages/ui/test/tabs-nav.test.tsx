// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs } from "../src/index";

afterEach(cleanup);

const navTabs = [
  { id: "all", label: "All", content: null },
  { id: "mine", label: "Mine", content: undefined },
];

describe("Tabs without content (tabs as nav)", () => {
  it("adds no tab stop after the active trigger", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tabs tabs={navTabs} />
        <button type="button">After</button>
      </>,
    );
    screen.getByRole("tab", { name: "All" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "After" }),
    );
  });

  it("keeps aria-controls valid with no axe violations", async () => {
    const { container } = render(
      <main>
        <Tabs tabs={navTabs} />
      </main>,
    );
    const tab = screen.getByRole("tab", { name: "All" });
    expect(
      document.getElementById(tab.getAttribute("aria-controls") ?? ""),
    ).not.toBeNull();
    const result = await axe.run(container);
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it("leaves panels with content unchanged", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tabs tabs={[{ id: "a", label: "A", content: "Body" }]} />
        <button type="button">After</button>
      </>,
    );
    screen.getByRole("tab", { name: "A" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tabpanel"));
  });
});
