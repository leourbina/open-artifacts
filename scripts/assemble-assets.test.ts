import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "apps",
  "server",
  "scripts",
  "assemble-assets.mjs",
);

function fixture(dashboardScripts: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "oa-assemble-"));
  const dash = path.join(root, "apps", "dashboard");
  mkdirSync(dash, { recursive: true });
  writeFileSync(
    path.join(dash, "package.json"),
    JSON.stringify({ name: "@oa/dashboard", scripts: dashboardScripts }),
  );
  return { root, out: path.join(root, "out") };
}
const run = (root: string, out: string) => {
  const r = spawnSync("node", [SCRIPT, "--root", root, "--out", out], {
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe("assemble-assets", () => {
  it("no dashboard build script → placeholder index.html and a warning", () => {
    const { root, out } = fixture({ dev: "echo" });
    const r = run(root, out);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/warn|placeholder/i);
    const html = readFileSync(path.join(out, "index.html"), "utf8");
    expect(html).toContain("<title>Open Artifacts</title>");
    expect(html).toContain("Dashboard not built yet");
  });

  it("dashboard has a build script but no dist/index.html → exit 1", () => {
    const { root, out } = fixture({ build: "vite build" });
    const r = run(root, out);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("index.html is missing");
    expect(existsSync(path.join(out, "index.html"))).toBe(false);
  });

  it("copies dashboard dist, and render/runtime dist into _oa/ when built", () => {
    const { root, out } = fixture({ build: "vite build" });
    const dist = path.join(root, "apps", "dashboard", "dist");
    mkdirSync(path.join(dist, "assets"), { recursive: true });
    writeFileSync(path.join(dist, "index.html"), "<p>dash</p>");
    writeFileSync(path.join(dist, "assets", "a.js"), "a");
    const render = path.join(root, "packages", "render", "dist");
    mkdirSync(path.join(render, ".vite"), { recursive: true });
    writeFileSync(path.join(render, "r.js"), "r");
    writeFileSync(path.join(render, ".vite", "manifest.json"), "{}");
    const r = run(root, out);
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(out, "index.html"), "utf8")).toBe(
      "<p>dash</p>",
    );
    expect(readFileSync(path.join(out, "assets", "a.js"), "utf8")).toBe("a");
    expect(readFileSync(path.join(out, "_oa", "r.js"), "utf8")).toBe("r");
    expect(existsSync(path.join(out, "_oa", "manifest.json"))).toBe(true);
    expect(existsSync(path.join(out, "_oa", "runtime.manifest.json"))).toBe(
      false,
    );
  });
});
