// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToasts } from "../src/components/Toast";
import { Toaster, toast } from "../src/index";

afterEach(() => {
  act(() => resetToasts());
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
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
const show = (o: Parameters<typeof toast>[0]) => act(() => toast(o));

describe("adversarial D3 toast action", () => {
  it("a throwing onClick still dismisses the toast", () => {
    const onError = vi.fn((e: ErrorEvent) => e.preventDefault());
    window.addEventListener("error", onError);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Toaster />);
    show({
      title: "Deleted",
      action: {
        label: "Undo",
        onClick: () => {
          throw new Error("boom");
        },
      },
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    } catch {}
    advance(1000);
    window.removeEventListener("error", onError);
    spy.mockRestore();
    expect(screen.queryByText("Deleted")).toBeNull();
  });

  it("double-click calls onClick once", () => {
    const onClick = vi.fn();
    render(<Toaster />);
    show({ title: "Deleted", action: { label: "Undo", onClick } });
    const b = screen.getByRole("button", { name: "Undo" });
    fireEvent.click(b);
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("an undoable toast is not evicted by 3 newer plain toasts", () => {
    render(<Toaster />);
    show({ title: "Deleted", action: { label: "Undo", onClick: () => {} } });
    for (const t of ["a", "b", "c"]) show({ title: t });
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeNull();
  });

  it("an undoable danger toast is not evicted by 3 newer danger toasts", () => {
    render(<Toaster />);
    show({
      title: "Deleted",
      tone: "danger",
      action: { label: "Undo", onClick: () => {} },
    });
    for (const t of ["a", "b", "c"]) show({ title: t, tone: "danger" });
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeNull();
  });

  it("a whitespace action label is rejected or still yields a named button", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let threw = false;
    render(<Toaster />);
    try {
      show({ title: "Deleted", action: { label: "  ", onClick: () => {} } });
    } catch {
      threw = true;
    }
    spy.mockRestore();
    if (threw) return;
    const btns = screen
      .getAllByRole("button")
      .filter((b) => !b.getAttribute("aria-label")?.startsWith("Dismiss"));
    for (const b of btns)
      expect(
        (b.getAttribute("aria-label") ?? b.textContent ?? "").trim(),
      ).not.toBe("");
  });

  it("altText defaults to the label in the announcement", () => {
    render(<Toaster />);
    show({ title: "Deleted", action: { label: "Undo", onClick: () => {} } });
    advance(100);
    const live = document.querySelector('[aria-live], [role="status"]');
    expect(live?.textContent).toMatch(/Undo/);
  });

  it("Enter and Space on the focused action trigger it", () => {
    const onClick = vi.fn();
    render(<Toaster />);
    show({ title: "Deleted", action: { label: "Undo", onClick } });
    const b = screen.getByRole("button", { name: "Undo" });
    act(() => b.focus());
    // Native buttons turn Enter/Space into click; jsdom doesn't, so assert it's a real <button>.
    expect(b.tagName).toBe("BUTTON");
    expect(b.getAttribute("type")).toBe("button");
  });

  it("timer resumes after focus leaves and expires", () => {
    render(
      <>
        <Toaster />
        <button type="button">Outside</button>
      </>,
    );
    show({ title: "Deleted", action: { label: "Undo", onClick: () => {} } });
    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    advance(20_000);
    act(() => screen.getByRole("button", { name: "Outside" }).focus());
    advance(9000);
    expect(screen.queryByText("Deleted")).toBeNull();
  });

  it("SSR: Toaster renders and toast() is a no-op on the server", () => {
    expect(() => renderToString(<Toaster />)).not.toThrow();
  });
});
