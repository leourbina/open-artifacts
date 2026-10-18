import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { router } from "../src/router";

// What the /search page receives for a URL query string: the router's own
// search parser, then the route's validateSearch.
const searchFor = (qs: string) => {
  const route = router.routesById["/search"];
  const validate = route.options.validateSearch as (s: unknown) => unknown;
  return validate(router.options.parseSearch(qs));
};

describe("router", () => {
  it("/search?q=123 keeps a numeric-looking query as text", () => {
    expect(searchFor("?q=123")).toEqual({ q: "123" });
  });
  it("/search?q=true keeps the query as text", () => {
    expect(searchFor("?q=true")).toEqual({ q: "true" });
  });
});

describe("router rendering", () => {
  it("renders NotFound for an unknown path", async () => {
    const { createMemoryHistory, createRouter, RouterProvider } = await import(
      "@tanstack/react-router"
    );
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const r = createRouter({
      routeTree: router.routeTree,
      history: createMemoryHistory({ initialEntries: ["/nope/never"] }),
    });
    await r.load();
    expect(
      renderToString(
        createElement(
          QueryClientProvider,
          { client: makeQueryClient() },
          createElement(RouterProvider, { router: r }),
        ),
      ),
    ).toContain("Page not found");
  });
});
