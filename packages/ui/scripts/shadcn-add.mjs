// `pnpm shadcn:add <name…>`: runs the pinned shadcn CLI, then pins any ranges
// it wrote to package.json and formats the generated files for Biome.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SHADCN = "shadcn@4.22.1";
const pkgDir = new URL("..", import.meta.url).pathname;
const run = (cmd, args, cwd = pkgDir) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });

// components.json points the CLI's CSS target at cli-sink.css so it never
// edits theme.css; keep the sink's header and drop whatever the CLI wrote.
const sink = `${pkgDir}src/shadcn/cli-sink.css`;
const sinkHeader = readFileSync(sink, "utf8");
try {
  run("pnpm", ["dlx", SHADCN, "add", ...process.argv.slice(2)]);
} finally {
  writeFileSync(sink, sinkHeader);
}

// The CLI saves deps with ^; pin them to the installed version instead.
const pkgPath = `${pkgDir}package.json`;
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
let changed = false;
for (const field of ["dependencies"]) {
  for (const [name, range] of Object.entries(pkg[field] ?? {})) {
    if (!/^[\^~]/.test(range)) continue;
    const installed = JSON.parse(
      readFileSync(`${pkgDir}node_modules/${name}/package.json`, "utf8"),
    ).version;
    pkg[field][name] = installed;
    changed = true;
  }
}
if (changed) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  run("pnpm", ["install"]);
}

run("pnpm", ["exec", "biome", "check", "--write", "src/shadcn"]);
