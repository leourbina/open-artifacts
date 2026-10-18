// M1 fixes without a reviewer test: document.title per route (10) and quota at /me (triage).
import { AUTH, QUOTA_MESSAGE } from "@oa/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { makeQueryClient, QUOTA_KEY } from "../src/api/queryClient";
import { RedirectProvider } from "../src/auth/redirect";
import { createAppRouter } from "../src/router";
import { useContentUrl } from "../src/viewer/useContentUrl";
import { arts, installHarness, server } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
  }),
}));

installHarness();

const id = (t: string) =>
  (arts.find((a) => a.title === t) as { id: string }).id;

const mount = (path: string) => {
  const redirect = vi.fn();
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RedirectProvider value={redirect}>
        <RouterProvider
          router={createAppRouter(
            createMemoryHistory({ initialEntries: [path] }),
          )}
        />
      </RedirectProvider>
    </QueryClientProvider>,
  );
  return redirect;
};
const err = (code: string, status: number) => () =>
  HttpResponse.json({ error: { code, message: code } }, { status });
const titled = (t: string) =>
  waitFor(() => expect(document.title).toBe(`${t} · Open Artifacts`));

describe("M1 document.title per route", () => {
  it("library", async () => {
    mount("/");
    await titled("Library");
  });

  it("search", async () => {
    mount("/search?q=notes");
    await titled("Search");
  });

  it("not found", async () => {
    mount("/nope");
    await titled("Not found");
  });

  it("viewer uses the artifact title once loaded", async () => {
    mount(`/a/${id("Landing page")}`);
    await titled("Landing page");
  });

  it("diff names the comparison", async () => {
    mount(`/a/${id("Landing page")}/diff/1/2`);
    await titled("Landing page v1 → v2");
  });

  it("anonymous visitor never sees a private artifact's title", async () => {
    server.use(
      http.get("*/api/v1/me", err("unauthorized", 401)),
      http.get("*/api/v1/artifacts/:id", err("not_found", 404)),
    );
    const seen: string[] = [];
    const obs = new MutationObserver(() => seen.push(document.title));
    obs.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    const redirect = mount(`/a/${id("Landing page")}`);
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(
        expect.stringContaining(AUTH.login),
      ),
    );
    obs.disconnect();
    expect([...seen, document.title].join("|")).not.toContain("Landing page");
  });
});

describe("M1 quota at /me", () => {
  it("shows the quota banner and a quota message, not the generic error", async () => {
    // Quota applies to every route, as on the real server.
    server.use(http.all("*/api/v1/*", err("quota_exceeded", 503)));
    mount("/");
    await screen.findByText(QUOTA_MESSAGE);
    expect(
      screen.getByRole("heading", { name: /daily limit/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load your account"),
    ).not.toBeInTheDocument();
  });
});

describe("M1 content URL errors and freshness", () => {
  const hook = (body: () => Response) => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return body();
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeQueryClient();
    const r = renderHook(() => useContentUrl("a1", 1), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    return { ...r, client, calls: () => n };
  };

  it("quota_exceeded raises the global quota flag and is not retried", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { result, client, calls } = hook(() =>
        Response.json(
          { error: { code: "quota_exceeded", message: "q" } },
          { status: 503 },
        ),
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(result.current.error).toBeTruthy();
      expect(client.getQueryData(QUOTA_KEY)).toBe(true);
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(calls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stale URL reports not fresh and refresh() returns a new one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let i = 0;
      const { result } = hook(() =>
        Response.json({
          url: `https://c.test/u${++i}`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(result.current.fresh()).toBe(true);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(result.current.fresh()).toBe(false);
      let next: string | null = null;
      await act(async () => {
        const p = result.current.refresh();
        await vi.advanceTimersByTimeAsync(0);
        next = await p;
      });
      expect(next).toBe("https://c.test/u2");
      expect(result.current.current).toBe("https://c.test/u2");
      expect(result.current.fresh()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
