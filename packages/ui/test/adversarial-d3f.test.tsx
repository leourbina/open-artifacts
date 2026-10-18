// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell, NavItem, Tabs, Toaster, toast } from "../src/index";

afterEach(cleanup);

describe("toast cap", () => {
  it("a new info toast is shown even when 3 danger toasts are up", () => {
    render(<Toaster />);
    act(() => {
      for (let i = 0; i < 3; i++) toast({ title: `d${i}`, tone: "danger" });
      toast({ title: "Link copied" });
    });
    expect(screen.queryByText("Link copied")).not.toBeNull();
  });
});

describe("Tabs by id", () => {
  // Rejected as a finding: ids must be unique. Dev builds warn instead.
  it("duplicate ids warn in development", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <Tabs
        tabs={[
          { id: "a", label: "One", content: "1" },
          { id: "a", label: "Two", content: "2" },
        ]}
      />,
    );
    expect(warn.mock.calls.flat().join(" ")).toMatch(/unique/);
    warn.mockRestore();
  });
});

describe("AppShell drawer", () => {
  it("closes on SPA link clicks that preventDefault (router <Link>)", async () => {
    const user = userEvent.setup();
    render(
      <AppShell
        nav={
          <a href="/lib" onClick={(e) => e.preventDefault()}>
            Library
          </a>
        }
      >
        <p>Content</p>
      </AppShell>,
    );
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("link", { name: "Library" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("NavItem", () => {
  it("count is separated from the label in the accessible name", () => {
    render(<NavItem href="/lib" label="Library" count={12} active />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("link", { name: "Library12" })).toBeNull();
  });
});
