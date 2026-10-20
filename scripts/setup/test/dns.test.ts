import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const line = (w: W, s: string) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === s);
const dnsError = (code: string) =>
  Object.assign(new TypeError("fetch failed"), { cause: { code } });
const FLUSH = "sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder";

/** Fails every fetch of `host` with `code` while `failing()` holds; DoH answers `doh`. */
function breakHost(
  w: W,
  host: string,
  code: string,
  opts: { failing?: () => boolean; doh?: "record" | "none" | "down" } = {},
) {
  const real = w.deps.fetch;
  const dohHits: string[] = [];
  w.deps.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (
      u.hostname === "cloudflare-dns.com" &&
      u.searchParams.get("type") === "A"
    ) {
      dohHits.push(
        `${u.searchParams.get("name")} ${new Headers(init?.headers).get("accept")}`,
      );
      if (opts.doh === "down") throw new Error("offline");
      return Response.json({
        Status: 0,
        ...(opts.doh === "record"
          ? { Answer: [{ name: `${host}.`, type: 1, data: "104.0.0.1" }] }
          : {}),
      });
    }
    if (u.hostname === host && (opts.failing?.() ?? true)) throw dnsError(code);
    return real(input, init);
  };
  return dohHits;
}

describe("#5: DNS-aware health checks", () => {
  it("surfaces undici's cause code in a health-check error", async () => {
    const w = world();
    const real = w.deps.fetch;
    w.deps.fetch = async (input, init) => {
      if (new URL(String(input)).pathname === "/healthz")
        throw dnsError("ECONNREFUSED");
      return real(input, init);
    };
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "healthcheck").message).toContain(
      "fetch failed (ECONNREFUSED)",
    );
  });

  it("keeps retrying an unresolved app host past the normal minute, then succeeds", async () => {
    const w = world();
    let n = 0;
    breakHost(w, "app.example.com", "ENOTFOUND", { failing: () => ++n <= 12 });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThan(60_000);
  });

  it("gives up after the (injectable) wait; the record is live in public DNS: exit 2 with the cache advice", async () => {
    const w = world();
    w.deps.dnsWaitMs = 120_000;
    const doh = breakHost(w, "app.example.com", "EAI_AGAIN", { doh: "record" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const l = line(w, "healthcheck");
    expect(l.status).toBe("action_required");
    expect(l.message).toBe(
      `Your machine's DNS cache has a stale miss for app.example.com; the record is live. Wait a few minutes or run \`${FLUSH}\` (macOS), then rerun.`,
    );
    expect(doh).toEqual(["app.example.com application/dns-json"]);
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120_000);
    expect(line(w, "owner-token")).toBeUndefined();
  });

  it("the default wait is 5 minutes", async () => {
    const w = world();
    breakHost(w, "app.example.com", "ENOTFOUND", { doh: "record" });
    await run(HOSTS, w.deps, ROOT);
    const total = w.sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(270_000);
    expect(total).toBeLessThanOrEqual(300_000);
  });

  it("no public record: exit 1 naming the missing record", async () => {
    const w = world();
    w.deps.dnsWaitMs = 60_000;
    breakHost(w, "app.example.com", "ENOTFOUND", { doh: "none" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    const l = line(w, "healthcheck");
    expect(l.status).toBe("error");
    expect(l.message).toContain("app.example.com has no public A record");
  });

  it("DoH unreachable: exit 1, says it could not check, and to wait 2 minutes", async () => {
    const w = world();
    w.deps.dnsWaitMs = 60_000;
    breakHost(w, "app.example.com", "ENOTFOUND", { doh: "down" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "healthcheck").message).toContain(
      "wait 2 minutes and rerun",
    );
  });

  it("the content host gets the same treatment", async () => {
    const w = world();
    w.deps.dnsWaitMs = 60_000;
    breakHost(w, "a.b.usercontent.example.com", "ENOTFOUND", { doh: "record" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const l = line(w, "selftest");
    expect(l.status).toBe("action_required");
    expect(l.message).toContain("stale miss for a.b.usercontent.example.com");
  });

  it("a host that isn't ours (the Access team domain) does not get the long DNS wait", async () => {
    const w = world();
    w.deps.dnsWaitMs = 10 * 60_000;
    breakHost(w, "team.cloudflareaccess.com", "ENOTFOUND", { doh: "record" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "healthcheck").message).toContain("not 200 after ~60s");
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(65_000);
  });
});
