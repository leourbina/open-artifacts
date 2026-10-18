// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  Button,
  Dialog,
  Menu,
  type MenuItem,
  Tabs,
  Toaster,
  toast,
} from "../src/index";
import { flushAnnouncement, useToastClock } from "./toast-clock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Dialog", () => {
  it("nested dialogs: one Escape closes only the inner one", async () => {
    const user = userEvent.setup();
    function Nested() {
      const [outer, setOuter] = useState(true);
      const [inner, setInner] = useState(true);
      return (
        <Dialog open={outer} onOpenChange={setOuter} title="Outer">
          <Button>outer action</Button>
          <Dialog open={inner} onOpenChange={setInner} title="Inner">
            <Button>inner action</Button>
          </Dialog>
        </Dialog>
      );
    }
    render(<Nested />);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
  });
});

describe("Menu", () => {
  const open = async (items: MenuItem[]) => {
    const user = userEvent.setup();
    render(<Menu trigger={<Button>Actions</Button>} items={items} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    return user;
  };

  it("onSelect fires exactly once per click", async () => {
    const onSelect = vi.fn();
    const user = await open([{ label: "Rename", onSelect }]);
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("duplicate labels render without React key errors", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await open([
      { label: "Copy", onSelect() {} },
      { label: "Copy", onSelect() {} },
    ]);
    expect(err).not.toHaveBeenCalled();
  });
});

describe("Tabs", () => {
  const tabs = [
    { id: "a", label: "Alpha", content: "A body" },
    { id: "b", label: "Beta", content: "B body" },
  ];

  it("a value matching no tab still selects one tab and shows its panel", () => {
    render(<Tabs tabs={tabs} value="nope" />);
    expect(
      screen
        .getAllByRole("tab")
        .some((t) => t.getAttribute("aria-selected") === "true"),
    ).toBe(true);
    expect(screen.queryByRole("tabpanel")).not.toBeNull();
  });

  it("ids with spaces keep the tab/panel IDREFs valid", () => {
    render(
      <Tabs
        tabs={[
          { id: "my files", label: "My files", content: "x" },
          { id: "shared", label: "Shared", content: "y" },
        ]}
      />,
    );
    const tab = screen.getByRole("tab", { name: "My files" });
    expect(tab.id).not.toMatch(/\s/);
    expect(screen.getByRole("tabpanel", { name: "My files" })).toBeTruthy();
  });

  it("duplicate ids render without React key errors", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <Tabs
        tabs={[
          { id: "a", label: "One", content: "1" },
          { id: "a", label: "Two", content: "2" },
        ]}
      />,
    );
    expect(err).not.toHaveBeenCalled();
  });
});

describe("toast()", () => {
  it("danger toasts are announced assertively", () => {
    useToastClock();
    render(<Toaster />);
    act(() => toast({ title: "Upload failed", tone: "danger" }));
    flushAnnouncement();
    const assertive = [
      ...document.querySelectorAll('[aria-live="assertive"]'),
    ].some((el) => el.textContent?.includes("Upload failed"));
    expect(assertive).toBe(true);
  });

  it("flooding 100 toasts keeps the visible stack bounded", () => {
    render(<Toaster />);
    act(() => {
      for (let i = 0; i < 100; i++) toast({ title: `t${i}` });
    });
    const viewport = screen.getByRole("region");
    expect(within(viewport).getAllByRole("listitem").length).toBeLessThan(10);
  });

  it("each dismiss control names which toast it dismisses", () => {
    render(<Toaster />);
    act(() => {
      toast({ title: "Copied link" });
      toast({ title: "Saved" });
    });
    const names = screen
      .getAllByRole("button", { name: /dismiss/i })
      .map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("AppShell", () => {
  const shell = (
    <AppShell nav={<a href="#lib">Library</a>} header={<span>Artifacts</span>}>
      <p>Content</p>
    </AppShell>
  );
  const openDrawer = async () => {
    const user = userEvent.setup();
    render(shell);
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    return user;
  };

  it("drawer closes when the viewport grows past 960px", async () => {
    await openDrawer();
    act(() => {
      window.innerWidth = 1200;
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("drawer exposes its links inside a navigation landmark", async () => {
    await openDrawer();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("navigation")).not.toBeNull();
  });

  it("following a nav link closes the drawer", async () => {
    const user = await openDrawer();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("link", { name: "Library" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has a skip link to <main> as the first focusable element", async () => {
    const user = userEvent.setup();
    render(shell);
    await user.tab();
    const first = document.activeElement as HTMLAnchorElement;
    const main = screen.getByRole("main");
    expect(first.tagName).toBe("A");
    expect(main.id).not.toBe("");
    expect(first.getAttribute("href")).toBe(`#${main.id}`);
  });
});
