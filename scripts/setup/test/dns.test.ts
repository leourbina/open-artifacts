import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const line = (w: W, s: string) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === s);
const dnsError = (code: string, hostname?: string) =>
  Object.assign(new TypeError("fetch failed"), {
    cause: { code, ...(hostname ? { hostname } : {}) },
  });
const MAC =
  "Wait a few minutes or run `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` (macOS)";
const total = (w: W) => w.sleeps.reduce((a, b) => a + b, 0);

/** What public DNS answers for one query type. */
type Doh =
  | "none" // NODATA
  | "nxdomain"
  | "servfail"
  | "html"
  | "A"
  | "AAAA"
  | "CNAME";
const ANSWER = { A: 1, AAAA: 28, CNAME: 5 } as const;

/**
 * Fails every fetch of `host` with `code` while `failing()` holds. DoH answers
 * `doh(type, n)` (n counts DoH questions so far).
 */
function breakHost(
  w: W,
  host: string,
  code: string,
  opts: {
    failing?: () => boolean;
    doh?: (type: string, n: number) => Doh;
  } = {},
) {
  const real = w.deps.fetch;
  const dohHits: string[] = [];
  w.deps.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.hostname === "cloudflare-dns.com" && u.pathname === "/dns-query") {
      const type = u.searchParams.get("type") ?? "";
      if (type === "A" || type === "AAAA") {
        dohHits.push(
          `${u.searchParams.get("name")} ${type} ${new Headers(init?.headers).get("accept")} ${init?.signal ? "signal" : "nosignal"}`,
        );
        const a = opts.doh?.(type, dohHits.length) ?? "none";
        if (a === "html") return new Response("<html>oops</html>");
        if (a === "servfail") return Response.json({ Status: 2 });
        if (a === "nxdomain") return Response.json({ Status: 3 });
        if (a === "none") return Response.json({ Status: 0 });
        return Response.json({
          Status: 0,
          Answer: [{ name: `${host}.`, type: ANSWER[a], data: "x" }],
        });
      }
    }
    if (u.hostname === host && (opts.failing?.() ?? true))
      throw dnsError(code, host);
    return real(input, init);
  };
  return dohHits;
}

describe("#5: DNS-aware health checks", () => {
  it("#5: surfaces undici's cause code in a health-check error", async () => {
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

  it("#5: keeps retrying an unresolved app host past the normal minute, then succeeds", async () => {
    const w = world();
    let n = 0;
    breakHost(w, "app.example.com", "ENOTFOUND", { failing: () => ++n <= 12 });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(total(w)).toBeGreaterThan(60_000);
  });

  it("#5: probes public DNS after about a minute; a live record stops the wait at once (exit 2)", async () => {
    const w = world();
    const doh = breakHost(w, "app.example.com", "EAI_AGAIN", {
      doh: () => "A",
    });
    w.deps.platform = "darwin";
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const l = line(w, "healthcheck");
    expect(l.status).toBe("action_required");
    expect(l.message).toBe(
      `Your machine's DNS cache has a stale miss for app.example.com; the record is live. ${MAC}, then rerun.`,
    );
    expect(total(w)).toBeGreaterThanOrEqual(60_000);
    expect(total(w)).toBeLessThan(120_000);
    expect(doh[0]).toBe("app.example.com A application/dns-json signal");
    expect(line(w, "owner-token")).toBeUndefined();
  });

  it("#5: not live at the probe: keeps waiting up to 5 minutes of wall-clock time, then exit 1 naming the missing record", async () => {
    const w = world();
    breakHost(w, "app.example.com", "ENOTFOUND", { doh: () => "none" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    const l = line(w, "healthcheck");
    expect(l.status).toBe("error");
    expect(l.message).toContain(
      "app.example.com has no public A, AAAA or CNAME record",
    );
    expect(total(w)).toBeGreaterThan(270_000);
    expect(total(w)).toBeLessThanOrEqual(300_000);
  });

  it("#5: the wait is wall-clock time (an injected clock), not a sum of sleeps", async () => {
    const w = world();
    let clock = 0;
    w.deps.now = () => clock;
    // every sleep really takes 3x as long as asked
    w.deps.sleep = async (ms) => {
      w.sleeps.push(ms);
      clock += ms * 3;
    };
    breakHost(w, "app.example.com", "ENOTFOUND", { doh: () => "none" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(total(w)).toBeLessThanOrEqual(110_000);
    expect(clock).toBeLessThanOrEqual(300_000 + 45_000);
  });

  it("#5: a record that appears during the wait is caught by the final check", async () => {
    const w = world();
    breakHost(w, "app.example.com", "ENOTFOUND", {
      doh: (_t, n) => (n <= 2 ? "none" : "CNAME"),
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(line(w, "healthcheck").message).toContain("stale miss");
  });

  it.each([["AAAA"], ["CNAME"]] as const)(
    "#5: an %s-only answer counts as live",
    async (type) => {
      const w = world();
      breakHost(w, "app.example.com", "ENOTFOUND", {
        doh: (t) => {
          if (type === "AAAA") return t === "AAAA" ? "AAAA" : "none";
          return t === "A" ? "CNAME" : "none";
        },
      });
      expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
      expect(line(w, "healthcheck").message).toContain("stale miss");
    },
  );

  it("#5: NXDOMAIN is a missing record", async () => {
    const w = world();
    w.deps.dnsWaitMs = 60_000;
    breakHost(w, "app.example.com", "ENOTFOUND", { doh: () => "nxdomain" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "healthcheck").message).toContain(
      "no public A, AAAA or CNAME record",
    );
  });

  it.each([["servfail"], ["html"]] as const)(
    "#5: a %s DoH answer is 'could not be checked; wait 2 minutes and rerun' (exit 1)",
    async (bad) => {
      const w = world();
      w.deps.dnsWaitMs = 60_000;
      breakHost(w, "app.example.com", "ENOTFOUND", { doh: () => bad });
      expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
      const m = line(w, "healthcheck").message;
      expect(m).toContain(
        "public DNS could not be checked; wait 2 minutes and rerun",
      );
    },
  );

  it("#5: DoH down or timing out is the same answer", async () => {
    const w = world();
    w.deps.dnsWaitMs = 60_000;
    const real = w.deps.fetch;
    w.deps.fetch = async (input, init) => {
      const u = new URL(String(input));
      if (u.hostname === "cloudflare-dns.com") throw new Error("timeout");
      if (u.hostname === "app.example.com")
        throw dnsError("ENOTFOUND", u.hostname);
      return real(input, init);
    };
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "healthcheck").message).toContain(
      "wait 2 minutes and rerun",
    );
  });

  it.each([
    ["darwin", MAC],
    [
      "linux",
      "Wait a few minutes or run `resolvectl flush-caches` (systemd-resolved)",
    ],
    ["win32", "Flush your OS DNS cache or wait a few minutes"],
  ])("#5: the flush hint on %s", async (platform, hint) => {
    const w = world();
    w.deps.platform = platform;
    breakHost(w, "app.example.com", "ENOTFOUND", { doh: () => "A" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(line(w, "healthcheck").message).toContain(hint);
  });

  it("#5: --ci gets no extended wait and no stale-cache diagnosis: ~60s, then exit 1 with the cause code and host", async () => {
    const w = world();
    const doh = breakHost(w, "app.example.com", "ENOTFOUND", {
      doh: () => "A",
    });
    const ci = [...HOSTS.filter((a) => a !== "--yes"), "--ci"];
    expect(await run(ci, w.deps, ROOT)).toBe(1);
    const l = line(w, "healthcheck");
    expect(l.status).toBe("error");
    expect(l.message).toContain("fetch failed (ENOTFOUND app.example.com)");
    expect(l.message).not.toContain("stale");
    expect(doh).toEqual([]);
    expect(total(w)).toBeLessThanOrEqual(65_000);
  });

  it("#5: the content host gets the same treatment", async () => {
    const w = world();
    breakHost(w, "a.b.usercontent.example.com", "ENOTFOUND", {
      doh: () => "A",
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const l = line(w, "selftest");
    expect(l.status).toBe("action_required");
    expect(l.message).toContain("stale miss for a.b.usercontent.example.com");
  });

  it("#5: the Access team-domain check never calls DoH and gets no long wait", async () => {
    const w = world();
    w.deps.dnsWaitMs = 10 * 60_000;
    const doh = breakHost(w, "team.cloudflareaccess.com", "ENOTFOUND", {
      doh: () => "A",
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "healthcheck").message).toContain("not 200 after ~60s");
    expect(doh).toEqual([]);
    expect(total(w)).toBeLessThanOrEqual(65_000);
  });
});
