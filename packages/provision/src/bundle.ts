import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { promisify } from "node:util";
import { parseTemplate } from "./metadata.js";

export type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<void>;

const run = promisify(execFile);
const defaultExec: Exec = async (cmd, args, opts) => {
  await run(cmd, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 });
};

export interface Bundle {
  modules: { name: string; type: "esm" | "wasm"; bytes: Uint8Array }[];
  mainModule: string;
  assetsDir: string;
  version: string;
}

const ZERO_ID = "00000000000000000000000000000000";

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** Build the server once per release with a dry-run deploy and dummy values. */
export async function buildBundle(
  root: string,
  exec: Exec = defaultExec,
): Promise<Bundle> {
  const tmp = await mkdtemp(join(tmpdir(), "oa-bundle-"));
  try {
    const serverDir = join(root, "apps/server");
    const tpl = parseTemplate(
      await readFile(join(serverDir, "wrangler.template.jsonc"), "utf8"),
    );
    // Dummy values; paths made absolute because the config lives in tmp.
    const dummy = JSON.parse(
      JSON.stringify(tpl)
        .replace(/\{\{WORKER_NAME\}\}/g, "oa-bundle")
        .replace(/\{\{(\w*HOST)\}\}/g, "x.invalid")
        .replace(/\{\{(D1_ID|KV_ID)\}\}/g, ZERO_ID)
        .replace(/\{\{(\w+)\}\}/g, "x"),
    );
    dummy.routes = undefined;
    dummy.triggers = undefined;
    dummy.main = join(serverDir, tpl.main);
    if (dummy.assets)
      dummy.assets.directory = join(serverDir, dummy.assets.directory);
    for (const d of dummy.d1_databases ?? [])
      if (d.migrations_dir)
        d.migrations_dir = join(serverDir, d.migrations_dir);
    const config = join(tmp, "wrangler.json");
    await writeFile(config, JSON.stringify(dummy));
    const outdir = join(tmp, "out");
    await mkdir(outdir, { recursive: true });
    await exec(
      "pnpm",
      [
        "--dir",
        "apps/server",
        "exec",
        "wrangler",
        "deploy",
        "--dry-run",
        "--outdir",
        outdir,
        "-c",
        config,
      ],
      { cwd: root },
    );
    const modules: Bundle["modules"] = [];
    for (const f of (await walk(outdir)).sort()) {
      const ext = extname(f);
      const type =
        ext === ".wasm"
          ? "wasm"
          : ext === ".js" || ext === ".mjs"
            ? "esm"
            : null;
      if (!type) continue;
      modules.push({
        name: relative(outdir, f).split("\\").join("/"),
        type,
        bytes: new Uint8Array(await readFile(f)),
      });
    }
    const main = `${basename(tpl.main, extname(tpl.main))}.js`;
    if (!modules.some((m) => m.name === main && m.type === "esm"))
      throw new Error(`wrangler output has no ${main}`);
    const pkg = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as {
      version: string;
    };
    return {
      modules,
      mainModule: main,
      assetsDir: "apps/server/dist-assets",
      version: pkg.version,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
