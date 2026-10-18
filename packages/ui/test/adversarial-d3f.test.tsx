// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tabs, Toaster, toast } from "../src/index";

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
