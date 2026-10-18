import { ArtifactSummarySchema, R } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";
import { qk } from "../src/api/queries";
import { makeQueryClient } from "../src/api/queryClient";

// TanStack disables retries when it thinks it runs on a server (no window); the app runs in a browser.
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = globalThis;
});
const { QueryObserver } = await import("@tanstack/react-query");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("query retries", () => {
  it("a 404 not_found (no access) is not retried by the app's QueryClient", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const qc = makeQueryClient();
    const obs = new QueryObserver(qc, {
      queryKey: qk.artifact("x"),
      queryFn: () => api.get(R.artifact("x"), ArtifactSummarySchema),
    });
    const unsub = obs.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    unsub();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
