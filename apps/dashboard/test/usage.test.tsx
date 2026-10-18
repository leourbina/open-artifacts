import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { installHarness, mount, server } from "./harness";

installHarness();

type Key = "requests" | "d1_reads" | "d1_writes" | "do_requests";
const usage = (metrics: { key: Key; used: number; limit: number }[]) =>
  server.use(
    http.get(`*${R.usage}`, () =>
      HttpResponse.json({ available: true, date: "2026-10-18", metrics }),
    ),
  );
const meter = (name: RegExp | string) => screen.findByRole("meter", { name });
const asRole = (role: "admin" | "member" | "guest") =>
  server.use(
    http.get(`*${R.me}`, () =>
      HttpResponse.json({
        ...fixtures.me,
        user: { ...fixtures.me.user, role },
      }),
    ),
  );

describe("usage", () => {
  it("shows setup steps when analytics is not available", async () => {
    server.use(
      http.get(`*${R.usage}`, () =>
        HttpResponse.json({
          available: false,
          date: "2026-10-18",
          metrics: [],
        }),
      ),
    );
    mount("/settings/usage");
    expect(await screen.findByText(/pnpm oa:setup/)).toBeTruthy();
    expect(
      screen.getByText(/wrangler secret put ANALYTICS_TOKEN/),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /copy/i }).length).toBe(2);
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("renders a meter per metric with used / limit, date and reset note", async () => {
    mount("/settings/usage");
    const m = await meter("Worker requests");
    expect(m.getAttribute("aria-valuenow")).toBe("1200");
    expect(m.getAttribute("aria-valuemax")).toBe("100000");
    expect(screen.getAllByRole("meter").length).toBe(4);
    expect(screen.getByText(/1,200/)).toBeTruthy();
    expect(screen.getByText(/Resets at 00:00 UTC/)).toBeTruthy();
    expect(screen.getByText(/2026-10-18/)).toBeTruthy();
  });

  it("85% is the warning tone", async () => {
    usage([{ key: "requests", used: 85, limit: 100 }]);
    mount("/settings/usage");
    expect((await meter(/requests/i)).getAttribute("data-tone")).toBe(
      "warning",
    );
  });

  it("80% is warning, 79.9% is normal", async () => {
    usage([
      { key: "requests", used: 80, limit: 100 },
      { key: "d1_reads", used: 799, limit: 1000 },
    ]);
    mount("/settings/usage");
    expect((await meter("Worker requests")).getAttribute("data-tone")).toBe(
      "warning",
    );
    expect((await meter("D1 rows read")).getAttribute("data-tone")).toBe(
      "normal",
    );
  });

  it("95% is danger, 94.9% is warning", async () => {
    usage([
      { key: "requests", used: 95, limit: 100 },
      { key: "d1_reads", used: 949, limit: 1000 },
    ]);
    mount("/settings/usage");
    expect((await meter("Worker requests")).getAttribute("data-tone")).toBe(
      "danger",
    );
    expect((await meter("D1 rows read")).getAttribute("data-tone")).toBe(
      "warning",
    );
  });

  it("limit 0 does not crash; with usage it is over the limit, without it is normal", async () => {
    usage([
      { key: "requests", used: 5, limit: 0 },
      { key: "d1_reads", used: 0, limit: 0 },
    ]);
    mount("/settings/usage");
    const m = await meter("Worker requests");
    expect(m.getAttribute("data-tone")).toBe("danger");
    expect((await meter("D1 rows read")).getAttribute("data-tone")).toBe(
      "normal",
    );
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("clamps over-limit percentage and bar", async () => {
    usage([{ key: "requests", used: 250, limit: 100 }]);
    mount("/settings/usage");
    const m = await meter("Worker requests");
    expect(m.getAttribute("data-tone")).toBe("danger");
    expect(screen.getByText("Limit reached")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/250%/);
    expect((m.firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  it("members are redirected away", async () => {
    asRole("member");
    const router = mount("/settings/usage");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("admins can see usage", async () => {
    asRole("admin");
    mount("/settings/usage");
    expect(await meter("Worker requests")).toBeTruthy();
  });
});
