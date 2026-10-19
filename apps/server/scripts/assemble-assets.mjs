// Assembles the Worker's static assets into apps/server/dist-assets:
//   apps/dashboard/dist/*   → dist-assets/      (required once the dashboard
//                                                has a build script; until
//                                                then a placeholder index.html)
//   packages/render/dist/*  → dist-assets/_oa/  (when built; B11)
//   packages/runtime/dist/* → dist-assets/_oa/  (when built; B13)
//   design/emails/logo@2x.png → dist-assets/email/ (invite/share email logo)
// Flags (for tests): --root <repo root> --out <output dir>.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const server = path.join(import.meta.dirname, "..");
const { values } = parseArgs({
  options: { root: { type: "string" }, out: { type: "string" } },
});
const root = path.resolve(values.root ?? path.join(server, "..", ".."));
const out = path.resolve(values.out ?? path.join(server, "dist-assets"));
const dashboardPkg = path.join(root, "apps", "dashboard", "package.json");
const dashboard = path.join(root, "apps", "dashboard", "dist");

const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Open Artifacts</title></head>
<body><p>Dashboard not built yet.</p></body></html>
`;

const hasBuild = (() => {
  try {
    const pkg = JSON.parse(readFileSync(dashboardPkg, "utf8"));
    return typeof pkg?.scripts?.build === "string";
  } catch {
    return false;
  }
})();
const built = existsSync(path.join(dashboard, "index.html"));

if (hasBuild && !built) {
  console.error(
    `assemble-assets: ${path.relative(root, dashboard)}/index.html is missing; build @oa/dashboard first.`,
  );
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (built) cpSync(dashboard, out, { recursive: true });
else {
  console.warn(
    "assemble-assets: warning: @oa/dashboard has no build script; writing a placeholder index.html",
  );
  writeFileSync(path.join(out, "index.html"), PLACEHOLDER);
}

for (const pkg of ["render", "runtime"]) {
  const dist = path.join(root, "packages", pkg, "dist");
  if (!existsSync(dist)) {
    console.warn(`assemble-assets: packages/${pkg}/dist not built; skipping`);
    continue;
  }
  const oa = path.join(out, "_oa");
  mkdirSync(oa, { recursive: true });
  cpSync(dist, oa, { recursive: true });
  // Vite writes its manifest to .vite/manifest.json by default.
  const vite = path.join(dist, ".vite", "manifest.json");
  const name = pkg === "render" ? "manifest.json" : "runtime.manifest.json";
  if (existsSync(vite) && !existsSync(path.join(oa, name)))
    cpSync(vite, path.join(oa, name));
}
const logo = path.join(root, "design", "emails", "logo@2x.png");
if (existsSync(logo)) {
  mkdirSync(path.join(out, "email"), { recursive: true });
  cpSync(logo, path.join(out, "email", "logo@2x.png"));
} else
  console.warn("assemble-assets: design/emails/logo@2x.png missing; skipping");
console.log(`assemble-assets: wrote ${path.relative(root, out)}`);
