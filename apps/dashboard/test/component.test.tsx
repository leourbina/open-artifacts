import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { NotFound } from "../src/pages/NotFound";

describe("NotFound", () => {
  it("renders its heading in the jsdom environment", () => {
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <NotFound />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("heading").textContent).toBe("Page not found");
  });
});
