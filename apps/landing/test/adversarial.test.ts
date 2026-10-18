import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// D7 adversarial review. Runs against the built site: `pnpm test` builds first.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(join(dist, p), "utf8");
const llms = read("llms.txt");

const htmlFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return htmlFiles(p);
    return p.endsWith(".html") ? [p] : [];
  });

describe("D7 adversarial", () => {
  // §6.4 + review brief: revoking access doesn't kill an already-minted signed
  // content URL; it stays valid until its 10-minute expiry. Must be documented.
  it("security docs say a signed URL outlives a revoke until it expires", () => {
    const security = read("docs/security.md");
    expect(security).toMatch(/revok|unshar/i);
    expect(security).toMatch(
      /(revok|unshar|remov)[^.]*\b(until|up to)\b[^.]*(10 minutes|expire)/i,
    );
  });

  // release-please manifest mode with a root package and no
  // include-component-in-tag: false tags releases `open-artifacts-vX.Y.Z`.
  // ls-remote's 'v*' pattern matches the last ref component only, so TAG
  // comes back empty and `git clone --branch ""` fails.
  it("the latest-tag lookup matches the tags release-please creates", () => {
    const config = JSON.parse(
      readFileSync(join(root, "release-please-config.json"), "utf8"),
    );
    const pkg = config.packages["."];
    const withComponent =
      (pkg["include-component-in-tag"] ??
        config["include-component-in-tag"]) !== false;
    const tag = withComponent ? `${pkg["package-name"]}-v0.1.0` : "v0.1.0";
    const pattern = llms.match(/--sort=-v:refname "\$REPO" '([^']+)'/)?.[1];
    expect(pattern).toBeDefined();
    const glob = new RegExp(
      `^${(pattern ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    );
    expect(glob.test(tag), `'${pattern}' vs ${tag}`).toBe(true);
  });

  // Without JS the Copy button renders, is focusable, and does nothing. It
  // should start hidden (script reveals it) and the prompt be select-all.
  it("the copy CTA degrades without JS", () => {
    const index = read("index.html");
    const button = index.match(/<button[^>]*data-copy[^>]*>/)?.[0] ?? "";
    expect(button).toMatch(/\shidden(\s|>|=)/);
    expect(index).toMatch(/\.cta-prompt\s*{[^}]*user-select:\s*all/);
  });

  // Internal TODO comments ship in every published HTML page. Only the
  // release-gate markers (see markers.test.ts) may appear.
  it("no internal TODO comments in the built HTML", () => {
    const allowed = new Set([
      "<!-- TODO(B14): fallback tool list -->",
      "<!-- TODO(D6): text wordmark -->",
    ]);
    for (const f of htmlFiles(dist)) {
      const todos = readFileSync(f, "utf8").match(/<!--\s*TODO[\s\S]*?-->/g);
      for (const todo of todos ?? []) expect(allowed, f).toContain(todo);
    }
  });
});
