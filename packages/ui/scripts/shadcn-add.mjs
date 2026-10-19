// `pnpm shadcn:add <name…>`: runs the pinned shadcn CLI, then pins any ranges
// it wrote to package.json and formats the generated files for Biome.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const SHADCN = "shadcn@4.22.1";
const pkgDir = new URL("..", import.meta.url).pathname;
const run = (cmd, args, cwd = pkgDir) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });

// components.json points the CLI's CSS target at cli-sink.css so it never
// edits theme.css. Print whatever the CLI wrote there (new vars, keyframes)
// so nothing is dropped silently, then reset the sink to its header.
const sink = `${pkgDir}src/shadcn/cli-sink.css`;
const sinkHeader = readFileSync(sink, "utf8");

// Existing components carry local changes (README), and the CLI's overwrite
// prompts can't be answered non-interactively. So run with --overwrite and
// put every file that already existed back as it was; only new files land.
const kept = new Map();
for (const dir of ["ui", "hooks", "lib"]) {
  const abs = `${pkgDir}src/shadcn/${dir}`;
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs))
    kept.set(`${abs}/${f}`, readFileSync(`${abs}/${f}`, "utf8"));
}
try {
  run("pnpm", ["dlx", SHADCN, "add", "--overwrite", ...process.argv.slice(2)]);
} finally {
  for (const [file, content] of kept)
    if (readFileSync(file, "utf8") !== content) {
      writeFileSync(file, content);
      console.log(`kept existing ${file.slice(pkgDir.length)}`);
    }
  const written = readFileSync(sink, "utf8");
  if (written !== sinkHeader) {
    const added = written.startsWith(sinkHeader)
      ? written.slice(sinkHeader.length)
      : written;
    console.log(
      "\nshadcn wrote this CSS to cli-sink.css (not applied; map anything" +
        " needed into theme.css by hand):\n",
    );
    console.log(added.trim());
    writeFileSync(sink, sinkHeader);
  }
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
