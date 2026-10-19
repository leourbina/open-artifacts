// Bundles the Worker with `wrangler deploy --dry-run` and fails if the script
// exceeds the Workers size limit (64 MiB uncompressed, both plans, since
// 2026-09-04). Assets don't count. The real constraint is startup time (1 s),
// so a gzipped size past GZIP_WARN only warns: keep heavy code lazy-imported.
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

const LIMIT = 64 * 1024 * 1024;
const GZIP_WARN = 3 * 1024 * 1024;
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
  const raw = files.reduce((n, f) => n + statSync(f).size, 0);
  const gz = files.reduce((n, f) => n + gzipSync(readFileSync(f)).length, 0);
  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  if (raw >= LIMIT) {
    console.error(
      `check-worker-size: ${mb(raw)} MiB uncompressed ≥ 64 MiB limit`,
    );
    process.exit(1);
  }
  if (gz >= GZIP_WARN)
    console.warn(
      `check-worker-size: warning: ${mb(gz)} MB gzipped ≥ 3 MB; check startup time (1 s limit)`,
    );
  console.log(
    `check-worker-size: ${mb(raw)} MiB uncompressed (< 64 MiB), ${mb(gz)} MB gzipped`,
  );
} finally {
  rmSync(out, { recursive: true, force: true });
}
