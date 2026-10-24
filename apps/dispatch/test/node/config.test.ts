import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAMESPACES, platformNames } from "@oa/provision";
import { describe, expect, it } from "vitest";

const app = join(dirname(fileURLToPath(import.meta.url)), "../..");
// Strip // and /* */ comments outside strings.
const strip = (s: string) =>
  s.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_m, str) => str ?? "",
  );
// biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
const cfg: any = JSON.parse(
  strip(readFileSync(join(app, "wrangler.jsonc"), "utf8")),
);
const ENVS = ["staging", "prod"] as const;

/** Keys that would attach the Worker to a hostname from the repo config. */
const ROUTING = ["route", "routes", "custom_domain", "custom_domains"];

describe("wrangler.jsonc", () => {
  it("names each env's Worker, namespace and HOSTS binding", () => {
    expect(Object.keys(cfg.env).sort()).toEqual(["prod", "staging"]);
    for (const env of ENVS) {
      const e = cfg.env[env];
      expect(e.name).toBe(platformNames(env).dispatch);
      expect(e.vars).toEqual({ OA_ENV: env });
      expect(e.dispatch_namespaces).toEqual([
        { binding: "DISPATCHER", namespace: NAMESPACES[env] },
      ]);
      expect(e.kv_namespaces).toEqual([
        { binding: "HOSTS", id: "{{HOSTS_KV_ID}}" },
      ]);
    }
    expect(platformNames("staging").hosts).toBe("oa-s-hosts");
    expect(platformNames("prod").hosts).toBe("oa-p-hosts");
  });

  it("has no routes, custom domains or workers.dev, at the top or in any env", () => {
    for (const c of [cfg, ...ENVS.map((e) => cfg.env[e])]) {
      for (const k of ROUTING) expect(c).not.toHaveProperty(k);
      expect(c.workers_dev).toBe(false);
      expect(c.preview_urls).toBe(false);
    }
    expect(JSON.stringify(cfg)).not.toMatch(/custom_domain|"pattern"|zone_/);
  });
});

describe("bundle", () => {
  it("wrangler deploy --dry-run is under 50 KB per env", () => {
    for (const env of ENVS) {
      const out = mkdtempSync(join(tmpdir(), "oa-dispatch-"));
      execFileSync(
        "pnpm",
        [
          "exec",
          "wrangler",
          "deploy",
          "--dry-run",
          "--env",
          env,
          "--outdir",
          out,
        ],
        {
          cwd: app,
          stdio: "pipe",
          env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
        },
      );
      const bytes = readdirSync(out)
        .filter((f) => f.endsWith(".js"))
        .reduce((n, f) => n + statSync(join(out, f)).size, 0);
      console.log(`dispatch bundle (${env}): ${bytes} bytes`);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(50 * 1024);
    }
  });
});
