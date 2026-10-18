import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotFound } from "../src/pages/NotFound";

describe("NotFound", () => {
  it("renders its heading in the jsdom environment", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading").textContent).toBe("Not found");
  });
});
