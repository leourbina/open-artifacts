// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AppShell, Banner, Button, EmptyState, NavItem } from "../src/index";

afterEach(cleanup);

const audit = async (root: Element = document.body) =>
  (
    await axe.run(root, { rules: { region: { enabled: false } } })
  ).violations.map((v) => v.id);

const icon = <svg aria-hidden="true" />;
const shell = (
  <AppShell
    nav={<a href="/library">Library</a>}
    header={<span>Artifacts</span>}
  >
    <p>Content</p>
  </AppShell>
);

const cases: Record<string, ReactElement> = {
  Banner: (
    <main>
      <Banner
        tone="warning"
        title="Quota almost used"
        action={<Button>Upgrade</Button>}
      >
        You have used 90% of storage.
      </Banner>
    </main>
  ),
  EmptyState: (
    <main>
      <EmptyState
        icon={icon}
        title="No artifacts yet"
        description="Publish one from an agent."
        action={<Button>Connect an agent</Button>}
      />
    </main>
  ),
  AppShell: shell,
  NavItem: (
    <nav aria-label="Primary">
      <NavItem href="#lib" label="Library" count={214} active />
      <NavItem href="#trash" label="Trash" />
    </nav>
  ),
};

describe("part 2b a11y", () => {
  for (const [name, el] of Object.entries(cases)) {
    it(`${name} has no axe violations`, async () => {
      const { container } = render(el);
      expect(await audit(container)).toEqual([]);
    });
  }
});

describe("AppShell drawer", () => {
  it("opens, closes, returns focus, and closes on Escape", async () => {
    const user = userEvent.setup();
    render(shell);
    const open = screen.getByRole("button", { name: "Open navigation" });
    await user.click(open);
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(await audit()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(open);
    await user.click(open);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(open);
  });
});

describe("NavItem", () => {
  it("marks the active item as the current page", () => {
    render(
      <>
        <NavItem href="#a" label="Library" active />
        <NavItem href="#b" label="Trash" />
      </>,
    );
    expect(
      screen
        .getByRole("link", { name: "Library" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "Trash" }).hasAttribute("aria-current"),
    ).toBe(false);
  });
});
