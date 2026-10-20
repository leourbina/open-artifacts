import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { makeQueryClient } from "./api/queryClient";
import { router } from "./router";
import "./styles.css";
import "./shadcn.css";

/** Dev-only: serve the API from in-browser MSW handlers. Dead-code-eliminated from production builds. */
async function startMocks() {
  if (import.meta.env.VITE_MOCK !== "1") return;
  const [
    { setupWorker },
    { createHandlers, fixtures },
    { HttpResponse, http },
  ] = await Promise.all([
    import("msw/browser"),
    import("@oa/shared/mocks"),
    import("msw"),
  ]);
  const params = new URLSearchParams(location.search);
  const quotaExceeded =
    import.meta.env.VITE_MOCK_QUOTA === "1" || params.get("mock") === "quota";
  const extra = [];
  // ?role=admin|member|guest: sign in as that role.
  const role = params.get("role");
  if (role === "admin" || role === "member" || role === "guest")
    extra.push(
      http.get("*/api/v1/me", () =>
        HttpResponse.json({
          ...fixtures.me,
          user: { ...fixtures.me.user, role },
        }),
      ),
    );
  // ?mock=name: no display name yet (suggested "Ada Lovelace"); after a PATCH the shared mock answers.
  if (params.get("mock") === "name") {
    let named = false;
    extra.push(
      http.get("*/api/v1/me", () =>
        named
          ? undefined
          : HttpResponse.json({
              ...fixtures.me,
              displayName: null,
              suggestedName: "Ada Lovelace",
              needsDisplayName: true,
            }),
      ),
      http.patch("*/api/v1/me", () => {
        named = true;
        return undefined;
      }),
    );
  }
  // ?mock=email: the instance sends invite/share emails; ?mock=email-fail: it
  // does, but every send fails (the shared mocks always answer emailed:false).
  const mail = params.get("mock");
  const emailEnabled = mail === "email" || mail === "email-fail";
  if (mail === "email")
    extra.push(
      http.post("*/api/v1/members", async ({ request }) => {
        const { email, role } = (await request.json()) as {
          email: string;
          role: string;
        };
        return HttpResponse.json(
          {
            id: `u_${Date.now()}`,
            email,
            name: null,
            role,
            lastSeenAt: null,
            emailed: true,
          },
          { status: 201 },
        );
      }),
      http.put("*/api/v1/artifacts/:id/shares", async ({ request }) => {
        const { email, role } = (await request.json()) as {
          email: string;
          role: string;
        };
        return HttpResponse.json({
          email,
          role,
          createdAt: new Date().toISOString(),
          emailed: true,
        });
      }),
    );
  // ?mock=update: v0.14.2 with v0.15.0 out; ?mock=uptodate and ?mock=custom
  // (a -dev build): a check with nothing to upgrade to.
  const checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const updates = {
    update: { current: "0.14.2", custom: false, updateAvailable: true },
    uptodate: { current: "0.15.0", custom: false, updateAvailable: false },
    custom: { current: "0.15.0-dev", custom: true, updateAvailable: false },
  } as const;
  const u = updates[params.get("mock") as keyof typeof updates];
  const update = u && {
    ...u,
    latestVersion: "0.15.0",
    breaking: false,
    notesUrl:
      "https://github.com/open-artifacts-ai/open-artifacts/releases/tag/v0.15.0",
    checkedAt,
  };
  // ?mock=cpu: 4 CPU-limit hits today, and the first two library requests get a 1102 (the first may be aborted).
  if (params.get("mock") === "cpu") {
    let hits = 0;
    extra.push(
      http.get("*/api/v1/usage", () =>
        HttpResponse.json({
          available: true,
          plan: "free",
          date: new Date().toISOString().slice(0, 10),
          metrics: [
            { key: "requests", used: 1200, limit: 100000 },
            { key: "d1_reads", used: 3400, limit: 5000000 },
            { key: "d1_writes", used: 120, limit: 100000 },
            { key: "do_requests", used: 80, limit: 100000 },
            { key: "cpu_limit_hits", used: 4, limit: 0 },
            { key: "cpu_p99_ms", used: 9.6, limit: 10 },
          ],
        }),
      ),
      http.get("*/api/v1/artifacts", () => {
        if (hits++ >= 2) return undefined;
        return new HttpResponse(
          "<!DOCTYPE html><title>Worker exceeded resource limits</title><h1>Error 1102</h1><p>Worker exceeded resource limits</p>",
          { status: 503, headers: { "content-type": "text/html" } },
        );
      }),
    );
  }
  // ?mock=paid: a Workers Paid instance (#279): no daily caps, 30 s of CPU.
  // ?mock=paid-cpu adds 4 CPU-limit hits today.
  const paidCpu = params.get("mock") === "paid-cpu";
  if (params.get("mock") === "paid" || paidCpu)
    extra.push(
      http.get("*/api/v1/usage", () =>
        HttpResponse.json({
          available: true,
          plan: "paid",
          date: new Date().toISOString().slice(0, 10),
          metrics: [
            { key: "requests", used: 182400, limit: 0 },
            { key: "d1_reads", used: 3400, limit: 0 },
            { key: "d1_writes", used: 120, limit: 0 },
            { key: "do_requests", used: 80, limit: 0 },
            { key: "kv_writes", used: 2300, limit: 0 },
            { key: "cpu_limit_hits", used: paidCpu ? 4 : 0, limit: 0 },
            { key: "cpu_p99_ms", used: 18.2, limit: 30000 },
          ],
        }),
      ),
    );
  // Mock-only: the mocks treat unauthenticated requests as anonymous, and a service worker
  // can't see the cookie header, so authenticate with a bearer token instead.
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const req = new Request(input, init);
    req.headers.set("Authorization", "Bearer mock");
    return realFetch(req);
  };
  await setupWorker(
    ...extra,
    ...createHandlers({
      quotaExceeded,
      emailEnabled,
      plan: params.get("mock")?.startsWith("paid") ? "paid" : "free",
      update,
    }),
  ).start({
    onUnhandledRequest: "bypass",
  });
}

await startMocks();
const queryClient = makeQueryClient();

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");
createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
