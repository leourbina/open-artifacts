// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Checkbox,
  IconButton,
  SegmentedControl,
  Select,
  Switch,
} from "../src/index";

afterEach(cleanup);

const fieldCss = readFileSync(
  `${import.meta.dirname}/../src/components/Field.module.css`,
  "utf8",
);
const opts = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
] as const;

describe("adversarial D3 part 1b", () => {
  it("Field controls have a disabled style (Button does; Input/Select/Switch/Checkbox look enabled)", () => {
    expect(fieldCss).toMatch(/:disabled\s*[,{]|\[data-disabled\]/);
  });

  it("Checkbox indeterminate is visible: CSS styles data-state=indeterminate", () => {
    // Indicator colour is --oa-surface on a --oa-surface box unless checked → invisible
    expect(fieldCss).toMatch(/\.checkbox\[data-state="indeterminate"\]/);
  });

  it("Checkbox indeterminate shows a dash, not the same checkmark as checked", () => {
    const glyph = (checked: boolean | "indeterminate") =>
      render(<Checkbox checked={checked} label="x" />)
        .container.querySelector("path")
        ?.getAttribute("d");
    expect(glyph("indeterminate")).toBeDefined();
    expect(glyph("indeterminate")).not.toBe(glyph(true));
  });

  it("SegmentedControl is a single tab stop (roving tabindex)", () => {
    const { getAllByRole } = render(
      <SegmentedControl
        aria-label="View"
        options={[...opts]}
        value="b"
        onChange={() => {}}
      />,
    );
    const items = getAllByRole("radio");
    const tabbable = items.filter((b) => b.tabIndex >= 0);
    expect(tabbable).toHaveLength(1);
  });

  it("SegmentedControl ArrowRight selects the next option", () => {
    const onChange = vi.fn();
    const { getByText } = render(
      <SegmentedControl
        aria-label="View"
        options={[...opts]}
        value="a"
        onChange={onChange}
      />,
    );
    const a = getByText("Alpha");
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("SegmentedControl exposes single-choice (radio) semantics, not independent toggles", () => {
    const { queryAllByRole } = render(
      <SegmentedControl
        aria-label="View"
        options={[...opts]}
        value="a"
        onChange={() => {}}
      />,
    );
    expect(queryAllByRole("radiogroup")).toHaveLength(1);
    expect(queryAllByRole("radio")).toHaveLength(3);
  });

  it('Select with an option value "" (allowed by T extends string) does not crash', () => {
    expect(() =>
      render(
        <Select
          aria-label="Pick"
          options={[{ value: "", label: "None" }, ...opts]}
          value="a"
          onChange={() => {}}
        />,
      ),
    ).not.toThrow();
  });

  it("Select reset to undefined shows the placeholder again (no stale uncontrolled value)", () => {
    const props = {
      "aria-label": "Pick",
      options: [...opts],
      onChange: () => {},
      placeholder: "Choose…",
    };
    const { getByRole, rerender } = render(<Select {...props} value="b" />);
    expect(getByRole("combobox").textContent).toContain("Beta");
    rerender(<Select {...props} value={undefined} />);
    expect(getByRole("combobox").textContent).toContain("Choose…");
  });

  it("Select value not among options still names the trigger (falls back to placeholder)", () => {
    const { getByRole } = render(
      <Select
        options={[...opts]}
        value={"zzz" as "a"}
        onChange={() => {}}
        placeholder="Choose…"
      />,
    );
    expect(getByRole("combobox").textContent?.trim()).toBeTruthy();
  });

  it("SegmentedControl ignores modified arrows (Alt+ArrowLeft is browser Back)", () => {
    const onChange = vi.fn();
    const { getByText } = render(
      <SegmentedControl
        aria-label="View"
        options={[...opts]}
        value="b"
        onChange={onChange}
      />,
    );
    fireEvent.keyDown(getByText("Beta"), { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(getByText("Beta"), { key: "End", metaKey: true });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("unlabelled Checkbox warns once, not on every render", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(<Checkbox />);
    rerender(<Checkbox />);
    rerender(<Checkbox />);
    const n = err.mock.calls.filter((c) =>
      String(c[0]).includes("needs a"),
    ).length;
    err.mockRestore();
    expect(n).toBeLessThanOrEqual(1);
  });
});

describe("adversarial D3 part 1b, final", () => {
  afterEach(() => vi.unstubAllEnvs());
  const unlabelled = () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Checkbox />);
    render(<Switch />);
    const n = err.mock.calls.filter((c) =>
      String(c[0]).includes("needs a"),
    ).length;
    err.mockRestore();
    return n;
  };
  const iconButtonThrows = () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<IconButton label=" " icon={null} />);
      return false;
    } catch {
      return true;
    } finally {
      err.mockRestore();
    }
  };

  it("warns and throws in dev", () => {
    vi.stubEnv("DEV", true);
    expect(unlabelled()).toBe(2);
    expect(iconButtonThrows()).toBe(true);
  });

  it("stays silent in prod", () => {
    vi.stubEnv("DEV", false);
    expect(unlabelled()).toBe(0);
    expect(iconButtonThrows()).toBe(false);
  });
});
