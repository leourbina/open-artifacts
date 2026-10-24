// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  Checkbox,
  Kbd,
  Textarea,
} from "../src/shadcn";

afterEach(cleanup);

describe("Alert", () => {
  it.each([
    ["danger", "alert"],
    ["destructive", "alert"],
    ["warning", "status"],
    ["success", "status"],
    ["info", "status"],
    [undefined, "status"],
  ] as const)("%s has role %s", (variant, role) => {
    render(<Alert variant={variant}>x</Alert>);
    expect(screen.getByRole(role)).toBeTruthy();
  });

  it("lets a caller override the role", () => {
    render(
      <Alert variant="danger" role="status">
        x
      </Alert>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["info", "bg-brand-soft"],
    ["success", "bg-success-soft"],
    ["warning", "bg-warning-soft"],
    ["danger", "bg-danger-soft"],
  ] as const)("%s uses %s with ink text", (variant, fill) => {
    render(<Alert variant={variant}>x</Alert>);
    const cls = screen.getByRole(
      variant === "danger" ? "alert" : "status",
    ).className;
    expect(cls).toContain(fill);
    expect(cls).toContain("text-foreground");
    expect(cls).toContain("border-transparent");
  });

  it("titles wrap instead of clamping to one line", () => {
    render(
      <Alert>
        <AlertTitle>A long title</AlertTitle>
      </Alert>,
    );
    expect(screen.getByText("A long title").className).not.toContain(
      "line-clamp",
    );
  });

  it("puts the action in its own trailing column", () => {
    render(
      <Alert variant="warning" size="sm">
        <AlertDescription>Text</AlertDescription>
        <AlertAction>
          <button type="button">Dismiss</button>
        </AlertAction>
      </Alert>,
    );
    const action = screen.getByText("Dismiss").parentElement as HTMLElement;
    expect(action.dataset.slot).toBe("alert-action");
    expect(action.className).toContain("col-start-3");
    const cls = screen.getByRole("status").className;
    expect(cls).toContain("py-1");
    // Row 1 and the next only with a title: row-span-2 alone would reset
    // the start and auto-place the action below the text.
    expect(cls).toContain(
      "has-[>[data-slot=alert-title]]:*:data-[slot=alert-action]:row-[1/span_2]",
    );
  });
});

describe("Checkbox", () => {
  it("shows a dash when indeterminate and a check when checked", () => {
    const { container, rerender } = render(
      <Checkbox aria-label="All" checked="indeterminate" />,
    );
    const box = screen.getByRole("checkbox");
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    expect(container.querySelector(".lucide-minus")).toBeTruthy();
    rerender(<Checkbox aria-label="All" checked />);
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector(".lucide-check")).toBeTruthy();
  });

  it("uses the solid focus outline, not a translucent ring", () => {
    render(<Checkbox aria-label="x" />);
    const cls = screen.getByRole("checkbox").className;
    expect(cls).toContain("focus-visible:outline-ring");
    expect(cls).not.toContain("ring-ring/50");
    expect(cls).not.toContain("dark:bg-input/30");
  });
});

describe("Textarea", () => {
  it("uses the solid focus outline and the strong border", () => {
    render(<Textarea aria-label="Notes" />);
    const cls = screen.getByRole("textbox").className;
    expect(cls).toContain("focus-visible:outline-ring");
    expect(cls).toContain("border-input");
    expect(cls).not.toContain("ring-ring/50");
    expect(cls).not.toContain("dark:bg-input/30");
  });
});

describe("Kbd", () => {
  it("renders a mono keycap", () => {
    render(<Kbd>⌘K</Kbd>);
    const k = screen.getByText("⌘K");
    expect(k.tagName).toBe("KBD");
    expect(k.className).toContain("font-mono");
  });
});
