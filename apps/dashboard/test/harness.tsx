import type { ArtifactSummary } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { RedirectProvider } from "../src/auth/redirect";
import { createAppRouter } from "../src/router";

const ORIGIN = "http://localhost";
export const server = setupServer();
/** Every /api/v1 request seen since the last test started. */
export const seen: URL[] = [];
export const arts = fixtures.artifacts as ArtifactSummary[];

type Entry = { isIntersecting: boolean };
let observers: ((entries: Entry[]) => void)[] = [];
/** Fire every IntersectionObserver callback as intersecting. */
export const intersect = () =>
  act(() => {
    for (const cb of observers) cb([{ isIntersecting: true }]);
  });

const shim = () => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (u: RequestInfo | URL, init?: RequestInit) =>
    // The mocks answer cookie-less requests as anonymous (401 on list/search).
    realFetch(new URL(u as string, ORIGIN).href, {
      ...init,
      headers: { ...init?.headers, cookie: "oa_session=test" },
    }),
  );
};

/** Registers msw, the fetch shim and an IntersectionObserver stub for a test file. */
export const installHarness = () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
    shim();
  });
  afterAll(() => {
    server.close();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    seen.length = 0;
    observers = [];
    server.use(
      http.all("*/api/v1/*", ({ request }) => {
        seen.push(new URL(request.url));
        return undefined;
      }),
      ...createHandlers(),
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (e: Entry[]) => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    localStorage.clear();
  });
  afterEach(() => {
    server.resetHandlers();
    vi.unstubAllGlobals();
    shim();
  });
};

export const mount = (path: string) => {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RedirectProvider value={vi.fn()}>
        <RouterProvider router={router} />
      </RedirectProvider>
    </QueryClientProvider>,
  );
  return router;
};

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const page = (items: unknown[], nextCursor: string | null) =>
  HttpResponse.json({ items, nextCursor });
