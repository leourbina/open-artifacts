// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../src/index";

afterEach(cleanup);
beforeEach(() => {
  // Date too: Radix measures elapsed time when pausing.
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "Date",
    ],
  });
});

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
const undo = vi.fn();
const showUndo = () =>
  act(() =>
    toast({
      title: "Artifact deleted",
      action: { label: "Undo", onClick: undo },
    }),
  );

describe("toast action", () => {
  beforeEach(() => undo.mockClear());

  // fireEvent, not user-event: RTL's async wrapper waits on a real
  // setTimeout, which never fires under vitest's fake timers. Radix moves
  // focus itself on F8 and on Tab inside the viewport.
  it("is reachable with F8 then Tab", () => {
    render(<Toaster />);
    showUndo();
    fireEvent.keyDown(document, { key: "F8", code: "F8" });
    const button = screen.getByRole("button", { name: "Undo" });
    for (let i = 0; i < 3 && document.activeElement !== button; i++) {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Tab",
      });
    }
    expect(document.activeElement).toBe(button);
  });

  it("calls onClick once and dismisses the toast", () => {
    render(<Toaster />);
    showUndo();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText("Artifact deleted")).toBeNull();
  });

  it("stays about 8s by default", () => {
    render(<Toaster />);
    showUndo();
    advance(6000);
    expect(screen.queryByText("Artifact deleted")).not.toBeNull();
    advance(2500);
    expect(screen.queryByText("Artifact deleted")).toBeNull();
  });

  it("pauses while focused or hovered", () => {
    render(<Toaster />);
    showUndo();
    const viewport = screen.getByRole("region");
    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    advance(20_000);
    expect(screen.queryByText("Artifact deleted")).not.toBeNull();
    act(() => screen.getByRole("button", { name: "Undo" }).blur());
    fireEvent.pointerMove(viewport.querySelector("ol") as Element);
    advance(20_000);
    expect(screen.queryByText("Artifact deleted")).not.toBeNull();
  });

  it("has no axe violations", async () => {
    render(
      <main>
        <Toaster />
      </main>,
    );
    showUndo();
    vi.useRealTimers(); // axe schedules its own timers
    const result = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it("leaves toasts without an action unchanged", () => {
    render(<Toaster />);
    act(() => toast({ title: "Link copied" }));
    expect(
      screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Dismiss: Link copied"]);
    advance(5100);
    expect(screen.queryByText("Link copied")).toBeNull();
  });

  it("keeps an Undo toast over three newer plain toasts", () => {
    render(<Toaster />);
    showUndo();
    for (const title of ["a", "b", "c"]) act(() => toast({ title }));
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeNull();
    expect(screen.queryByText("a")).toBeNull();
  });

  it("treats a blank action label as no action", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Toaster />);
    act(() =>
      toast({ title: "Deleted", action: { label: "  ", onClick: undo } }),
    );
    expect(err.mock.calls.flat().join(" ")).toMatch(/label/);
    err.mockRestore();
    expect(screen.getAllByRole("button")).toHaveLength(1); // just Dismiss
    advance(5100);
    expect(screen.queryByText("Deleted")).toBeNull();
  });
});
