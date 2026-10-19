import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { renderTokenPage, TEMPLATE_PATH } from "../src/token-page.ts";
import { type Perm, tokenById, tokens, withUrls } from "../src/tokens.ts";
import { core, ROOT } from "./fakes.ts";
import { BASE, HOSTS, onboarded, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parsed = (w: { lines: string[] }) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, step: string) => parsed(w).find((j) => j.step === step);
const issue = (w: W, id: string) =>
  line(w, "prereqs").data.tokens?.find((t: { id: string }) => t.id === id);
const TWO = [
  ...["--name", "open-artifacts", "--owner-email", "o@example.com"],
  ...["--app-host", "app.example.com", "--content-host", "content.other.com"],
  ...["--yes", "--json", "--solo"],
];
const twoZones = () =>
  world({
    zones: ["example.com", "other.com"],
    zoneIds: { "example.com": "z1", "other.com": "z2" },
  });

describe("M1: zone-scoped tokens cover every zone of the hosts", () => {
  it("--token-links lists both zones in zoneScope and drops the single zoneId", async () => {
    const w = twoZones();
    const args = [
      ...["--token-links", "--json", "--account-id", "acc1"],
      ...["--app-host", "app.example.com", "--content-host", "content.other.com"],
    ];
    expect(await run(args, w.deps, ROOT)).toBe(0);
    const t = JSON.parse(w.lines.at(-1) as string).data.tokens;
    const deploy = t.find((x: { id: string }) => x.id === "deploy");
    expect(deploy.zoneScope).toEqual({
      mode: "specific",
      zones: ["example.com", "other.com"],
    });
    expect(deploy.url).not.toContain("zoneId=");
    for (const id of ["access", "analytics"])
      expect(t.find((x: { id: string }) => x.id === id).zoneScope).toBeUndefined();
  });
  it("one zone: zoneScope names it, zoneId stays in the URL", async () => {
    const w = twoZones();
    const args = [
      ...["--token-links", "--json", "--account-id", "acc1"],
      ...["--app-host", "app.example.com", "--content-host", "c.example.com"],
    ];
    await run(args, w.deps, ROOT);
    const deploy = JSON.parse(w.lines.at(-1) as string).data.tokens[0];
    expect(deploy.zoneScope).toEqual({ mode: "specific", zones: ["example.com"] });
    expect(deploy.url).toContain("zoneId=z1");
  });
  it("prereqs probes the zone permissions on every zone", async () => {
    const w = twoZones();
    w.deps.env.CLOUDFLARE_API_TOKEN = "dep";
    const seen: string[] = [];
    const f = w.deps.fetch;
    w.deps.fetch = async (u, i) => {
      seen.push(new URL(String(u)).pathname);
      return f(u, i);
    };
    await run(TWO, w.deps, ROOT);
    for (const z of ["z1", "z2"]) {
      expect(seen).toContain(`/client/v4/zones/${z}/workers/routes`);
      expect(seen).toContain(`/client/v4/zones/${z}/dns_records`);
    }
    expect(issue(w, "deploy")?.zoneScope ?? { zones: ["example.com", "other.com"] }).toMatchObject({
      zones: ["example.com", "other.com"],
    });
  });
  it("the token page says to pick the specific zones, by name, never id", () => {
    const tpl = readFileSync(TEMPLATE_PATH, "utf8");
    const list = withUrls(tokens(), {
      accountId: "acc1",
      zones: [
        { id: "z1", name: "example.com" },
        { id: "z2", name: "other.com" },
      ],
    });
    const html = renderTokenPage(list, tpl);
    expect(html).toContain(
      "Under Zone Resources, change All zones to Specific zone → <b>example.com</b> and <b>other.com</b>",
    );
    expect(html.match(/Under Zone Resources/g)).toHaveLength(1);
    expect(html).not.toMatch(/\bz[12]\b/);
  });
});

describe("M2: required permissions come from the calls setup makes", () => {
  // Every Cloudflare call setup makes, by the token that makes it, mapped to
  // the permission group it needs. An unmapped call fails the test, so a new
  // call forces a decision here and in the table.
  const API: [RegExp, string | null][] = [
    [/^GET \/user\/tokens\/verify$/, null],
    [/^GET \/accounts\/[^/]+\/subscriptions$/, "billing:read"],
    [/^GET \/zones$/, "zone:read"],
    [/^GET \/zones\/[^/]+\/dns_records$/, "dns:read"],
    [/^(GET|POST|PUT|DELETE) \/accounts\/[^/]+\/access\/(apps|policies)(\/.*)?$/, "access:edit"],
    [/^GET \/accounts\/[^/]+\/access\/organizations$/, "access_acct:read"],
    [/^GET \/accounts\/[^/]+\/workers\/scripts\/[^/]+\/settings$/, "workers_scripts:read"],
    [/^GET \/accounts\/[^/]+\/r2\/buckets\/[^/]+$/, "workers_r2:read"],
    [/^GET \/accounts\/[^/]+\/storage\/kv\/namespaces$/, "workers_kv_storage:read"],
    [/^GET \/accounts\/[^/]+\/d1\/database$/, "d1:read"],
  ];
  const WRANGLER: [RegExp, string[]][] = [
    [/^(whoami|auth token)\b/, []],
    [/^d1 (create|execute|migrations apply)\b/, ["d1:edit"]],
    [/^kv namespace create\b/, ["workers_kv_storage:edit"]],
    [/^r2 bucket create\b/, ["workers_r2:edit"]],
    [/^secret (list|put|delete)\b/, ["workers_scripts:edit"]],
    // The config's routes are custom domains (wrangler.template.jsonc), which
    // need Workers Routes and DNS on the zone.
    [/^deploy\b/, ["workers_scripts:edit", "workers_routes:edit", "dns:edit"]],
  ];
  const covers = (have: Perm[], need: string) => {
    const [key, type] = need.split(":");
    return have.some((p) => p.key === key && (p.type === "edit" || type === "read"));
  };

  it("the table equals what a full team install's calls need, per token", async () => {
    const PAID = [{ rate_plan: { id: "WORKERS_PAID" }, state: "Paid" }];
    const w = world({ subscriptions: PAID, dns: onboarded("mail.app.example.com") });
    w.deps.env.CLOUDFLARE_API_TOKEN = "dep";
    w.deps.env.OA_ACCESS_TOKEN = "acc";
    const calls: string[] = [];
    const f = w.deps.fetch;
    w.deps.fetch = async (u, i) => {
      const url = new URL(String(u));
      // prereqs' permission probes ask about the table; they are not needs.
      const probe = new Error().stack?.includes("tokenIssues");
      if (url.host === "api.cloudflare.com" && !probe) {
        const auth = new Headers(i?.headers).get("authorization") ?? "";
        calls.push(`${auth.replace("Bearer ", "")} ${i?.method ?? "GET"} ${url.pathname.replace("/client/v4", "")}`);
      }
      return f(u, i);
    };
    expect(await run([...BASE, "--team", "--yes-paid"], w.deps, ROOT)).toBe(0);
    const need: Record<string, Set<string>> = { dep: new Set(), acc: new Set() };
    for (const c of calls) {
      const [tok, ...rest] = c.split(" ");
      const call = rest.join(" ");
      const m = API.find(([re]) => re.test(call));
      expect(m, `unmapped API call: ${call}`).toBeDefined();
      if (m?.[1]) need[tok as string]?.add(m[1]);
    }
    for (const a of w.argv.filter((x) => x.includes(" exec wrangler "))) {
      const cmd = a.split(" exec wrangler ")[1] as string;
      const m = WRANGLER.find(([re]) => re.test(cmd));
      expect(m, `unmapped wrangler call: ${cmd}`).toBeDefined();
      for (const p of m?.[1] ?? []) need.dep?.add(p);
    }
    // The Worker's Usage page (apps/server) is the analytics token's only user.
    const usage = readFileSync(
      join(import.meta.dirname, "../../../apps/server/src/services/usage.ts"),
      "utf8",
    );
    expect(usage).toMatch(/graphql/i);
    expect(usage).toContain("env.ANALYTICS_TOKEN");
    const derived = {
      deploy: [...(need.dep ?? [])],
      access: [...(need.acc ?? [])],
      analytics: ["account_analytics:read"],
    };
    for (const t of tokens()) {
      const want = derived[t.id];
      for (const n of want) expect(covers(t.permissions, n), `${t.id} needs ${n}`).toBe(true);
      for (const p of t.permissions)
        expect(
          want.some((n) => n.split(":")[0] === p.key),
          `${t.id} has ${p.key}:${p.type} but no call needs it`,
        ).toBe(true);
    }
  });

  it("prereqs flags an ANALYTICS_TOKEN that verifies to the deploy token's id", async () => {
    const w = world({ tokenIds: { dep: "t1", an: "t1" } });
    w.deps.env.CLOUDFLARE_API_TOKEN = "dep";
    w.deps.env.ANALYTICS_TOKEN = "an";
    await run(HOSTS, w.deps, ROOT);
    expect(issue(w, "analytics")).toMatchObject({ status: "reused" });
    expect(line(w, "prereqs").message).toContain("is the deploy token");
  });
  it("a dedicated ANALYTICS_TOKEN is not flagged", async () => {
    const w = world();
    w.deps.env.CLOUDFLARE_API_TOKEN = "dep";
    w.deps.env.ANALYTICS_TOKEN = "an";
    await run(HOSTS, w.deps, ROOT);
    expect(issue(w, "analytics")).toBeUndefined();
  });
});

describe("L5: Billing: Read is optional", () => {
  it("is marked optional with why", () => {
    const b = tokenById("deploy").permissions.find((p) => p.key === "billing");
    expect(b).toMatchObject({ required: false, note: "lets setup detect your plan" });
    expect(tokenById("deploy").permissions.filter((p) => p.required === false)).toHaveLength(1);
  });
  it("its absence is a note marked optional, not a lack", async () => {
    const w = world();
    w.deps.env.CLOUDFLARE_API_TOKEN = "dep";
    await run(HOSTS, w.deps, ROOT);
    expect(line(w, "prereqs").message).toMatch(/Billing: Read \(optional, lets setup detect your plan\)/);
    expect(issue(w, "deploy")).toMatchObject({ status: "optional", missing: [] });
  });
  it("never shows under --ci or --check --strict, nor the unset analytics token", async () => {
    for (const extra of [["--ci"], ["--check", "--strict"]]) {
      const w = world();
      w.deps.env.CLOUDFLARE_API_TOKEN = "dep";
      w.deps.env.OA_ACCESS_TOKEN = "acc";
      await run([...HOSTS, ...extra], w.deps, ROOT);
      const pre = line(w, "prereqs");
      expect(pre.message, extra.join(" ")).not.toContain("Billing: Read (optional");
      expect(pre.message, extra.join(" ")).not.toContain("analytics token not set");
      expect(pre.data.tokens, extra.join(" ")).toBeUndefined();
    }
  });
});

describe("L6: token-only flags need a token command", () => {
  for (const extra of [["--repo", "a/b"], ["--no-open"]])
    it(`rejects ${extra[0]} without --token-links/--token-page`, async () => {
      const c = core();
      expect(await run([...HOSTS, ...extra], c.deps, ROOT)).toBe(1);
      const j = JSON.parse(c.lines[0] as string);
      expect(j).toMatchObject({ step: "args", status: "error" });
      expect(j.message).toContain("--token-links");
    });
});

describe("Info: escaping covers purpose, accountId and zone names", () => {
  it("escapes them", () => {
    const tpl = readFileSync(TEMPLATE_PATH, "utf8");
    const list = withUrls(
      tokens().map((t) => ({ ...t, purpose: `<i>${t.id}</i>"` })),
      { accountId: '<acc">', zones: [{ id: "z", name: '<zone>"&' }] },
    );
    const html = renderTokenPage(list, tpl);
    expect(html).not.toContain("<i>");
    expect(html).toContain("&lt;i&gt;deploy&lt;/i&gt;&quot;");
    expect(html).not.toContain('<acc">');
    expect(html).not.toContain("<zone>");
    expect(html).toContain("&lt;zone&gt;&quot;&amp;");
  });
});
