// Builds Ladle once for all browser test files and serves it; tests read
// the URL with inject("ladleUrl").
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    ladleUrl: string;
  }
}

const pkg = resolve(import.meta.dirname, "..");
const out = "node_modules/.cache/oa-ladle-a11y";
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

export default async function setup(project: TestProject) {
  execFileSync("pnpm", ["exec", "ladle", "build", "-o", out], {
    cwd: pkg,
    stdio: "pipe",
  });
  const root = join(pkg, out);
  const server = createServer((req, res) => {
    const path = join(root, new URL(req.url ?? "/", "http://x").pathname);
    const file =
      existsSync(path) && statSync(path).isFile()
        ? path
        : join(root, "index.html");
    res.setHeader("content-type", types[extname(file)] ?? "text/plain");
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  project.provide("ladleUrl", `http://127.0.0.1:${port}`);
  return () => new Promise<void>((r) => server.close(() => r()));
}
