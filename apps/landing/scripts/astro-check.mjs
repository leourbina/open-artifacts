// `astro check` exits 0 without checking anything when @astrojs/check fails to
// load (it logs "packages are required" and returns). Fail loudly instead.
import { spawnSync } from "node:child_process";

const run = spawnSync("astro", ["check", ...process.argv.slice(2)], {
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
  shell: process.platform === "win32",
  env: { ...process.env, CI: process.env.CI ?? "1" },
});
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");

const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
if (run.status !== 0) process.exit(run.status ?? 1);
if (!output.includes("Getting diagnostics")) {
  console.error(
    "astro check did not run (could @astrojs/check not load?). Try `pnpm install --force`.",
  );
  process.exit(1);
}
