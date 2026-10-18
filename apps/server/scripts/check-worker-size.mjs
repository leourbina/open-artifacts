// Bundles the Worker with `wrangler deploy --dry-run` and fails if the gzipped
// script exceeds the Workers Free limit (3 MB). Assets don't count.
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

const LIMIT = 3 * 1024 * 1024;
const server = path.join(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "oa-worker-"));
try {
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--outdir",
      out,
      "-c",
      "wrangler.test.jsonc",
    ],
    { cwd: server, stdio: ["ignore", "ignore", "inherit"] },
  );
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|wasm)$/.test(f)) files.push(p);
    }
  };
  walk(out);
  if (files.length === 0) throw new Error("no bundle produced");
  const gz = files.reduce((n, f) => n + gzipSync(readFileSync(f)).length, 0);
  const mb = (gz / 1024 / 1024).toFixed(2);
  if (gz >= LIMIT) {
    console.error(`check-worker-size: ${mb} MB gzipped ≥ 3 MB limit`);
    process.exit(1);
  }
  console.log(`check-worker-size: ${mb} MB gzipped (< 3 MB)`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
