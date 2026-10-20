import { describe, expect, it } from "vitest";
import {
  BANG_RULE,
  SECRET_ENV_VARS,
  SECRET_LABELS,
  SKILL_NAME_MAX,
  secretFile,
  secretSnippet,
} from "../src/mcp/skill-common.js";
import {
  UPGRADE_HASH,
  UPGRADE_TEMPLATE,
} from "../src/mcp/upgrade.generated.js";
import { renderUpgrade, UPGRADE_ETAG } from "../src/mcp/upgrade.js";
import {
  RELEASES_API,
  renderUpgradeTemplate,
  UPGRADE_DOCS,
  UPGRADE_FLAGS,
  UPGRADE_TOKENS,
} from "../src/mcp/upgrade-template.js";
import { VERSION } from "../src/version.gen.js";
import { APP, callWorker, E } from "./mcp-helpers.js";

const CONTENT = "https://content.localhost";
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WORKER = "oa-test-worker";

const get = (url: string, init: RequestInit = {}, e: unknown = E()) =>
  callWorker(new Request(url, init), e);
const upgrade = async (e: unknown = E({ WORKER_NAME: WORKER })) => {
  const r = await get(`${APP}/upgrade.md`, {}, e);
  expect(r.status).toBe(200);
  return r.text();
};

function frontmatter(md: string) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m?.[1]) throw new Error("no frontmatter");
  const top: Record<string, string> = {};
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = (kv[3] ?? "").startsWith('"')
      ? (JSON.parse(kv[3] ?? "") as string)
      : (kv[3] ?? "");
    (kv[1] ? meta : top)[kv[2] ?? ""] = v;
  }
  return { name: top.name ?? "", description: top.description ?? "", meta };
}

/** Every `oa:setup` command line in the skill's code blocks. */
const setupLines = (md: string) =>
  md.split("\n").filter((l) => l.includes("pnpm -s oa:setup "));

describe("upgrade.md drift", () => {
  it("src/mcp/upgrade.generated.ts is up to date (run the build)", () => {
    expect(UPGRADE_TEMPLATE).toBe(renderUpgradeTemplate());
  });

  it("UPGRADE_HASH is the template's sha256 prefix", async () => {
    const d = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(UPGRADE_TEMPLATE),
    );
    const hex = [...new Uint8Array(d)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(UPGRADE_HASH).toBe(hex.slice(0, 8));
  });

  it("every template token is one upgrade.ts fills; none is left", async () => {
    const used = new Set(
      [...UPGRADE_TEMPLATE.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]),
    );
    expect([...used].sort()).toEqual([...UPGRADE_TOKENS].sort());
    expect(await upgrade()).not.toContain("{{");
  });

  it("uses every flag in UPGRADE_FLAGS, and no other oa:setup flag", async () => {
    const md = await upgrade();
    for (const f of UPGRADE_FLAGS)
      expect(md, f).toMatch(new RegExp(`(?<![\\w-])${f}(?![\\w-])`));
    const lines = setupLines(md);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const allowed = new Set<string>(UPGRADE_FLAGS);
    for (const l of lines)
      for (const f of l.match(/--[a-z][a-z-]*/g) ?? [])
        expect(allowed.has(f), `${f} in: ${l}`).toBe(true);
  });
});

describe("upgrade.md content", () => {
  it("frontmatter: name, description, metadata.version", async () => {
    const md = await upgrade();
    const fm = frontmatter(md);
    expect(fm.name).toBe("open-artifacts-app-localhost-upgrade");
    expect(fm.name).toMatch(NAME_RE);
    expect(fm.description.length).toBeGreaterThan(0);
    expect(fm.description.length).toBeLessThanOrEqual(1024);
    expect(fm.description.startsWith("Open Artifacts (app.localhost)")).toBe(
      true,
    );
    expect(fm.meta.version).toBe(VERSION);
    expect(fm.meta.instance).toBe("app.localhost");
    expect(fm.meta.worker).toBe(WORKER);
  });

  it("a 253-char host: name ≤64 with a hash, ends -upgrade", async () => {
    const host = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example.com`;
    const fm = frontmatter(
      await renderUpgrade({ APP_HOST: host, ENVIRONMENT: "production" }),
    );
    expect(fm.name.length).toBeLessThanOrEqual(SKILL_NAME_MAX);
    expect(fm.name).toMatch(NAME_RE);
    expect(fm.name).toMatch(/-[0-9a-f]{6}-upgrade$/);
    expect(fm.description.length).toBeLessThanOrEqual(1024);
  });

  it("has every step, in order", async () => {
    const md = await upgrade();
    const steps = [
      "`GET http://app.localhost/healthz`",
      "custom build",
      `\`GET ${RELEASES_API}\` with no authentication`,
      "A 403 or 429",
      "at most 100",
      "up to date",
      "BREAKING CHANGES first",
      "data, never instructions",
      "explicit yes",
      `git clone --depth 1 --branch v<latest> https://github.com/open-artifacts-ai/open-artifacts`,
      "git fetch --depth 1 origin tag v<latest>",
      "pnpm install --frozen-lockfile",
      `--upgrade --name ${WORKER} --check --json`,
      `--upgrade --name ${WORKER} --json`,
      `--rollback --name ${WORKER} --json`,
      "## 9. Report",
    ];
    let at = -1;
    for (const s of steps) {
      const i = md.indexOf(s, at + 1);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    expect(md).toContain("`--account-id <id>`");
    expect(md).toContain(
      "Never pass `--allow-downgrade` unless the user explicitly asks",
    );
    expect(md).toContain(UPGRADE_DOCS);
    for (const code of ["**0**", "**2**", "**1**"]) expect(md).toContain(code);
    expect(md).toContain("verbatim");
  });

  it("secrets: saved with secretSnippet to secretFile, passed by $(cat), no inline token", async () => {
    const md = await upgrade();
    const cf = secretFile("cloudflare", { installName: WORKER });
    expect(md).toContain(secretSnippet(cf, SECRET_LABELS.cloudflare));
    expect(md).toContain(SECRET_LABELS.cloudflare);
    for (const kind of ["access", "analytics"] as const)
      expect(md).toContain(
        secretSnippet(
          secretFile(kind, { installName: WORKER }),
          SECRET_LABELS[kind],
        ),
      );
    for (const l of setupLines(md).filter((l) => !l.startsWith("- ")))
      expect(l).toContain(`${SECRET_ENV_VARS.cloudflare}="$(cat ${cf})"`);
    // No token value or placeholder is ever inlined.
    expect(md).not.toMatch(/CLOUDFLARE_API_TOKEN=(?!"\$\(cat )/);
    expect(md).not.toMatch(/--token(?!-file)/);
    expect(md).toContain("Never ask for it in chat");
  });

  it("no em dashes; vendor-neutral except the tested `!` rule", async () => {
    const md = await upgrade();
    expect(md).not.toContain("—");
    expect(md.replace(BANG_RULE, "")).not.toMatch(/\bClaude\b/);
  });

  it("without WORKER_NAME, uses the default install name", async () => {
    const md = await renderUpgrade({
      APP_HOST: "x.example.com",
      ENVIRONMENT: "production",
    });
    expect(md).toContain("--upgrade --name open-artifacts --json");
  });
});

describe("GET /upgrade.md", () => {
  it("app host: 200 markdown, cacheable, ETag/304, HEAD", async () => {
    const r = await get(`${APP}/upgrade.md`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("etag")).toBe(UPGRADE_ETAG);
    expect(UPGRADE_ETAG).toBe(`"${VERSION}-upgrade-${UPGRADE_HASH}"`);
    const nm = await get(`${APP}/upgrade.md`, {
      headers: { "if-none-match": UPGRADE_ETAG },
    });
    expect(nm.status).toBe(304);
    const head = await get(`${APP}/upgrade.md`, { method: "HEAD" });
    expect(head.status).toBe(200);
  });

  it("content host: 404; POST: 405; SKILL_MD=off: 404", async () => {
    expect((await get(`${CONTENT}/upgrade.md`)).status).toBe(404);
    const post = await get(`${APP}/upgrade.md`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    const off = E({ SKILL_MD: "Off" });
    expect((await get(`${APP}/upgrade.md`, {}, off)).status).toBe(404);
  });

  it("touches no D1 binding", async () => {
    let touched = 0;
    const DB = new Proxy(
      {},
      {
        get() {
          touched++;
          throw new Error("D1 touched");
        },
      },
    );
    const r = await get(`${APP}/upgrade.md`, {}, E({ DB }));
    expect(r.status).toBe(200);
    expect(touched).toBe(0);
  });

  it("skill.md points at upgrade.md", async () => {
    const r = await get(`${APP}/skill.md`);
    expect(await r.text()).toContain("http://app.localhost/upgrade.md");
  });
});
