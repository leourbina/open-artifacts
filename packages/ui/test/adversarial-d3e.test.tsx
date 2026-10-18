// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tabs, Toaster, toast } from "../src/index";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("toast cap", () => {
  it("is announced assertively for danger (sanity)", async () => {
    render(<Toaster />);
    act(() => toast({ title: "Disk full", tone: "danger" }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(
      [...document.querySelectorAll('[aria-live="assertive"]')].some((e) =>
        e.textContent?.includes("Disk full"),
      ),
    ).toBe(true);
  });

  it("a danger toast is not silently evicted by later info toasts", () => {
    render(<Toaster />);
    act(() => {
      toast({ title: "Upload failed", tone: "danger" });
      toast({ title: "i1" });
      toast({ title: "i2" });
      toast({ title: "i3" });
    });
    expect(screen.queryByText("Upload failed")).not.toBeNull();
  });
});

describe("Tabs index-based values", () => {
  it("uncontrolled selection follows the tab, not its position, when tabs are inserted", async () => {
    const user = userEvent.setup();
    const a = { id: "a", label: "Alpha", content: "A body" };
    const b = { id: "b", label: "Beta", content: "B body" };
    const { rerender } = render(<Tabs tabs={[a, b]} />);
    await user.click(screen.getByRole("tab", { name: "Beta" }));
    rerender(<Tabs tabs={[{ id: "z", label: "Zed", content: "Z" }, a, b]} />);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      "Beta",
    );
  });
});
