// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { type ReactElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Dialog, Menu, Tabs, Toaster, toast } from "../src/index";
import { flushAnnouncement, useToastClock } from "./toast-clock";

afterEach(cleanup);

// Portals land outside landmarks; that is the app shell's concern.
const audit = async (root: Element = document.body) =>
  (
    await axe.run(root, { rules: { region: { enabled: false } } })
  ).violations.map((v) => v.id);

function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Share"
        description="Invite people"
        footer={<Button>Done</Button>}
      >
        <input aria-label="Email" />
      </Dialog>
    </>
  );
}

const onRename = vi.fn();
const onDelete = vi.fn();
const menu = (
  <Menu
    trigger={<Button>Actions</Button>}
    items={[
      { label: "Rename", onSelect: onRename },
      "separator",
      { label: "Delete", onSelect: onDelete, danger: true },
    ]}
  />
);
const tabs = (
  <Tabs
    tabs={[
      { id: "versions", label: "Versions", content: "v-panel" },
      { id: "share", label: "Share", content: "s-panel" },
      { id: "details", label: "Details", content: "d-panel" },
    ]}
  />
);

const cases: Record<string, ReactElement> = { Menu: menu, Tabs: tabs };

describe("part 2 a11y", () => {
  for (const [name, el] of Object.entries(cases)) {
    it(`${name} has no axe violations`, async () => {
      render(<main>{el}</main>);
      expect(await audit()).toEqual([]);
    });
  }
});

describe("Dialog", () => {
  it("traps focus, closes on Escape, and passes axe while open", async () => {
    const user = userEvent.setup();
    render(<DialogDemo />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "Share" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    expect(await audit()).toEqual([]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open" }),
    );
  });
});

describe("Menu", () => {
  it("is keyboard navigable", async () => {
    const user = userEvent.setup();
    render(menu);
    screen.getByRole("button", { name: "Actions" }).focus();
    await user.keyboard("{Enter}");
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(await audit()).toEqual([]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    expect(items[1]?.getAttribute("data-danger")).toBe("true");
    await user.keyboard("{Enter}");
    expect(onDelete).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });
});

describe("Tabs", () => {
  it("moves with arrow keys", async () => {
    const user = userEvent.setup();
    render(tabs);
    screen.getByRole("tab", { name: "Versions" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("tab", { name: "Share" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("s-panel");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement?.textContent).toBe("Details");
  });
});

describe("toast", () => {
  it("announces in a polite live region", async () => {
    useToastClock();
    render(<Toaster />);
    act(() => toast({ title: "Copied link", tone: "success" }));
    expect(screen.getAllByText("Copied link")).not.toHaveLength(0);
    // Radix announces through a separate polite region, two frames later.
    flushAnnouncement();
    const live = [...document.querySelectorAll('[aria-live="polite"]')];
    expect(live.some((el) => el.textContent?.includes("Copied link"))).toBe(
      true,
    );
    vi.useRealTimers(); // axe schedules its own timers
    expect(await audit()).toEqual([]);
  });
});
