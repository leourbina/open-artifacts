import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHarness, mount, server } from "./harness";

installHarness();

type Key =
  | "requests"
  | "d1_reads"
  | "d1_writes"
  | "do_requests"
  | "cpu_limit_hits"
  | "cpu_p99_ms";
const usage = (metrics: { key: Key; used: number; limit: number }[]) =>
  server.use(
    http.get(`*${R.usage}`, () =>
      HttpResponse.json({
        available: true,
        plan: "free",
        date: "2026-10-18",
        metrics,
      }),
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
  // The default mock reports "today"; pin the clock so the date never drifts.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("shows setup steps when analytics is not available", async () => {
    server.use(
      http.get(`*${R.usage}`, () =>
        HttpResponse.json({
          available: false,
          plan: "free",
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

  it("limit 0 is no daily cap: the count alone, no bar, no cap, no alert (#279)", async () => {
    usage([
      { key: "requests", used: 182400, limit: 0 },
      { key: "d1_reads", used: 0, limit: 0 },
      { key: "d1_writes", used: 5, limit: 100 },
    ]);
    mount("/settings/usage");
    const card = (await screen.findByRole("region", {
      name: "Worker requests",
    })) as HTMLElement;
    expect(card.textContent).toContain("182,400today");
    expect(card.textContent).not.toMatch(/\/|left|%/);
    expect(screen.queryByRole("meter", { name: "Worker requests" })).toBeNull();
    expect(screen.queryByRole("meter", { name: "D1 rows read" })).toBeNull();
    // Capped metrics keep their bar.
    expect(await meter("D1 rows written")).toBeTruthy();
    expect(screen.queryByText(/have reached today's limit/)).toBeNull();
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

describe("usage CPU card", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const BASE = [
    { key: "requests" as const, used: 1200, limit: 100000 },
    { key: "d1_reads" as const, used: 3400, limit: 5000000 },
    { key: "d1_writes" as const, used: 120, limit: 100000 },
    { key: "do_requests" as const, used: 80, limit: 100000 },
  ];
  const cpu = (hits: number, p99: number, p99Limit = 10) =>
    usage([
      ...BASE,
      { key: "cpu_limit_hits", used: hits, limit: 0 },
      { key: "cpu_p99_ms", used: p99, limit: p99Limit },
    ]);
  const card = () => screen.findByRole("region", { name: "CPU" });
  const hitsRow = async () =>
    (await screen.findByText("Requests over the CPU limit today"))
      .parentElement as HTMLElement;
  const p99 = () => screen.findByRole("meter", { name: "p99 CPU time" });

  it("is its own card after the four meters, never a meter or an alert", async () => {
    cpu(4, 9.6);
    mount("/settings/usage");
    await card();
    expect(screen.getByText("A per-request limit, not a daily quota"));
    // Four daily meters plus the p99 bar; cpu_limit_hits (limit 0) is no meter.
    expect(screen.getAllByRole("meter").length).toBe(5);
    expect(screen.queryByRole("meter", { name: "CPU limit hits" })).toBeNull();
    expect(screen.queryByText(/have reached today's limit/)).toBeNull();
    expect(screen.getByText("9.6 ms")).toBeTruthy();
    expect(screen.getByText("of 10 ms")).toBeTruthy();
    expect(screen.queryByText(/Free plan requests get 10 ms/)).toBeNull();
  });

  it("hits: neutral at 0 and 2, warning from 3", async () => {
    const tones: Record<number, string> = {
      0: "normal",
      2: "normal",
      3: "warning",
    };
    for (const [hits, tone] of Object.entries(tones)) {
      cpu(Number(hits), 4);
      mount("/settings/usage");
      const row = await hitsRow();
      expect(row.getAttribute("data-tone")).toBe(tone);
      expect(row.textContent).toContain(hits);
      expect(row.textContent).toMatch(
        Number(hits)
          ? /stopped with Cloudflare error 1102/
          : /No request was stopped/,
      );
      cleanup();
    }
  });

  it("p99 bar: normal under 8 ms, warning from 8, danger from 10", async () => {
    const tones: [number, string, string][] = [
      [7.9, "normal", "79"],
      [8, "warning", "80"],
      [9.6, "warning", "96"],
      [10, "danger", "100"],
      [14, "danger", "100"],
    ];
    for (const [ms, tone, width] of tones) {
      cpu(0, ms);
      mount("/settings/usage");
      const m = await p99();
      expect(m.getAttribute("data-tone")).toBe(tone);
      expect((m.firstElementChild as HTMLElement).style.width).toMatch(
        new RegExp(`^${width}(\\.\\d+)?%$`),
      );
      cleanup();
    }
  });

  it("no bar when the p99 limit is 0 (Workers Paid)", async () => {
    cpu(0, 42, 0);
    mount("/settings/usage");
    await card();
    expect(screen.getByText("42 ms")).toBeTruthy();
    expect(screen.queryByRole("meter", { name: "p99 CPU time" })).toBeNull();
    expect(screen.queryByText(/of 0 ms/)).toBeNull();
  });

  it("no card when both metrics are absent; one row when one is", async () => {
    usage(BASE);
    mount("/settings/usage");
    await meter("Worker requests");
    expect(screen.queryByRole("region", { name: "CPU" })).toBeNull();
    cleanup();

    usage([...BASE, { key: "cpu_limit_hits", used: 1, limit: 0 }]);
    mount("/settings/usage");
    await card();
    expect(screen.getByText("Requests over the CPU limit today")).toBeTruthy();
    expect(screen.queryByText("Typical busy request (p99)")).toBeNull();
  });

  it("no requests yet today: no p99 figure", async () => {
    usage([
      ...BASE.map((m) => ({ ...m, used: 0 })),
      { key: "cpu_limit_hits", used: 0, limit: 0 },
      { key: "cpu_p99_ms", used: 0, limit: 10 },
    ]);
    mount("/settings/usage");
    expect(await screen.findByText("No requests yet today")).toBeTruthy();
    expect(screen.queryByRole("meter", { name: "p99 CPU time" })).toBeNull();
  });

  it("not configured: setup only, no CPU card", async () => {
    server.use(
      http.get(`*${R.usage}`, () =>
        HttpResponse.json({
          available: false,
          plan: "free",
          date: "2026-10-18",
          metrics: [],
        }),
      ),
    );
    mount("/settings/usage");
    await screen.findByText(/pnpm oa:setup/);
    expect(screen.queryByRole("region", { name: "CPU" })).toBeNull();
  });

  it("the plan line sits at the top for owners and admins", async () => {
    for (const role of [null, "admin"] as const) {
      if (role) asRole(role);
      mount("/settings/usage");
      const line = await screen.findByText(
        /Workers Free is sized for one person\./,
      );
      expect(line.textContent).toContain(
        "Workers Paid ($5 a month) is sized for a team: it sends invite emails and gives each request up to 30 seconds of CPU.",
      );
      expect(
        screen
          .getByRole("link", { name: /Compare plans/ })
          .getAttribute("href"),
      ).toBe("https://open-artifacts.com/docs/self-hosting-costs/");
      cleanup();
    }
  });
});

describe("usage per plan (#279)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const respond = (body: object) =>
    server.use(
      http.get(`*${R.usage}`, () =>
        HttpResponse.json({ available: true, date: "2026-10-18", ...body }),
      ),
    );
  const PLAN_LINE = /Workers Free is sized for one person\./;

  it("Free: daily caps, the 10 ms CPU line and the plan line", async () => {
    respond({
      plan: "free",
      metrics: [
        { key: "requests", used: 1200, limit: 100000 },
        { key: "kv_writes", used: 300, limit: 1000 },
        { key: "cpu_p99_ms", used: 9.6, limit: 10 },
      ],
    });
    mount("/settings/usage");
    expect(await meter("Worker requests")).toBeTruthy();
    expect(screen.getByText("/ 100,000 today")).toBeTruthy();
    expect(screen.getByText("/ 1,000 today")).toBeTruthy();
    expect(screen.getByText("of 10 ms")).toBeTruthy();
    expect(screen.getByText(PLAN_LINE)).toBeTruthy();
  });

  it("Paid: no daily caps, 'of 30 s' on the CPU card, the Paid plan line", async () => {
    respond({
      plan: "paid",
      metrics: [
        { key: "requests", used: 182400, limit: 0 },
        { key: "kv_writes", used: 2300, limit: 0 },
        { key: "cpu_limit_hits", used: 0, limit: 0 },
        { key: "cpu_p99_ms", used: 18.2, limit: 30000 },
      ],
    });
    mount("/settings/usage");
    await screen.findByRole("region", { name: "CPU" });
    expect(screen.queryByText(/\/ [\d,]+ today/)).toBeNull();
    expect(screen.getByText("18.2 ms")).toBeTruthy();
    expect(screen.getByText("of 30 s")).toBeTruthy();
    expect((await meter("p99 CPU time")).getAttribute("aria-valuetext")).toBe(
      "18.2 ms of 30 s",
    );
    expect(screen.queryByText("of 10 ms")).toBeNull();
    expect(screen.queryByText(PLAN_LINE)).toBeNull();
    const line = screen.getByText(/This instance is on Workers Paid\./);
    expect(line.textContent).toBe(
      "This instance is on Workers Paid. There are no daily limits, and each request gets up to 30 seconds of CPU. Usage beyond what the plan includes is billed by Cloudflare. See pricing",
    );
    expect(
      screen.getByRole("link", { name: /See pricing/ }).getAttribute("href"),
    ).toBe("https://developers.cloudflare.com/workers/platform/pricing/");
    expect(
      (await screen.findByRole("region", { name: "Worker requests" }))
        .textContent,
    ).toContain("182,400today");
  });

  it("no plan (older server): treated as Free", async () => {
    respond({ metrics: [{ key: "requests", used: 1, limit: 100000 }] });
    mount("/settings/usage");
    expect(await screen.findByText(PLAN_LINE)).toBeTruthy();
  });
});
