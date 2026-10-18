// M1 fixes without a reviewer test: document.title, quota at /me, Open raw, session expiry, paging.
import { AUTH, QUOTA_MESSAGE, type VersionInfo } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  act,
  fireEvent,
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

describe("M1 Open raw", () => {
  const fakeWindow = () => {
    const w = {
      opener: {} as unknown,
      location: { href: "about:blank" },
      close: vi.fn(),
    };
    const open = vi.spyOn(window, "open").mockReturnValue(w as never);
    return { w, open };
  };
  const raw = () => screen.findByRole("button", { name: "Open raw" });

  it("is a button (no href to middle-click), opens a blank tab synchronously and fills it", async () => {
    mount(`/a/${id("Landing page")}`);
    const btn = await raw();
    expect(screen.queryByRole("link", { name: "Open raw" })).toBeNull();
    const { w, open } = fakeWindow();
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(w.opener).toBeNull();
    await waitFor(() => expect(w.location.href).toMatch(/^https?:\/\//));
    expect(w.close).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("refreshes a stale URL before filling the tab; closes it on failure", async () => {
    mount(`/a/${id("Landing page")}`);
    const btn = await raw();
    let refetches = 0;
    server.use(
      http.get("*/api/v1/artifacts/:id/content-url", () => {
        refetches++;
        return HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        );
      }),
    );
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    const { w, open } = fakeWindow();
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    await waitFor(() => expect(w.close).toHaveBeenCalled());
    expect(w.location.href).toBe("about:blank");
    expect(refetches).toBe(1);
    await screen.findByText(/couldn't open/i);
    clock.mockRestore();
    open.mockRestore();
  });
});

describe("M1 session expiry on the viewer", () => {
  const unauthorized = () =>
    HttpResponse.json(
      { error: { code: "unauthorized", message: "unauthorized" } },
      { status: 401 },
    );

  it("a 401 elsewhere on a private artifact sends the viewer to sign in", async () => {
    server.use(http.get("*/api/v1/artifacts/:id/versions", unauthorized));
    const redirect = mount(`/a/${id("Landing page")}`);
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(
        expect.stringContaining(AUTH.login),
      ),
    );
  });

  it("a 401 elsewhere on a public artifact stays in the anonymous view", async () => {
    server.use(http.get("*/api/v1/artifacts/:id/versions", unauthorized));
    const redirect = mount(`/a/${id("Q4 report")}`);
    await screen.findByRole("link", { name: "Sign in" }, { timeout: 2000 });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("M1 versions paging (contract C2)", () => {
  it("a short page is not the last page; only an empty one is", async () => {
    const SCRIPT = id("Parser script");
    const all = [
      ...((fixtures.versions as Record<string, VersionInfo[]>)[SCRIPT] ?? []),
    ].sort((a, b) => b.version - a.version);
    const befores: (string | null)[] = [];
    server.use(
      http.get("*/api/v1/artifacts/:id/versions", ({ request }) => {
        const b = new URL(request.url).searchParams.get("before");
        befores.push(b);
        const before = b ? Number(b) : Number.POSITIVE_INFINITY;
        return HttpResponse.json(
          all.filter((x) => x.version < before).slice(0, 7),
        );
      }),
    );
    mount(`/a/${SCRIPT}?panel=open&tab=versions`);
    await screen.findByText("Update 25");
    expect(screen.queryByText("Update 18")).toBeNull();
    const more = () =>
      screen.findByRole("button", { name: "Load older versions" });
    fireEvent.click(await more());
    await screen.findByText("Update 18");
    fireEvent.click(await more());
    await screen.findByText("Update 11");
    fireEvent.click(await more());
    await screen.findByText("Update 4");
    // v4–v1 is short too; only the empty page after it ends the timeline.
    fireEvent.click(await more());
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load older versions" }),
      ).toBeNull(),
    );
    expect(befores).toContain("1");
  });
});
