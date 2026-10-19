// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { Banner } from "../src/index";

describe("Banner", () => {
  it("still renders a titled banner as before", () => {
    render(
      <Banner tone="warning" title="Quota reached">
        Resets at 00:00 UTC
      </Banner>,
    );
    expect(screen.getByText("Quota reached").tagName).toBe("STRONG");
  });

  it("renders a compact, untitled strip with a hidden icon", () => {
    const { container } = render(
      <Banner tone="info" compact icon={<svg data-testid="ic" />}>
        This artifact hasn't responded yet.
      </Banner>,
    );
    expect(container.querySelector("strong")).toBeNull();
    expect(
      screen.getByTestId("ic").parentElement?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("calls onDismiss from a labelled button", () => {
    const onDismiss = vi.fn();
    render(<Banner tone="warning" title="CPU" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("has no axe violations with every option set", async () => {
    const { container } = render(
      <main>
        <Banner
          tone="warning"
          title="CPU"
          icon={<svg />}
          compact
          onDismiss={() => {}}
        >
          Body
        </Banner>
      </main>,
    );
    const r = await axe.run(container);
    expect(r.violations).toEqual([]);
  });
});
