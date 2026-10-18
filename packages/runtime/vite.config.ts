import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin, type UserConfig } from "vite";

/**
 * Library builds into a flat dist/ served under /_oa/ on the content host:
 *   `vite build --mode snapshot` → snapshot.<hash>.js (ES module; html-to-image)
 *   `vite build --mode schemas`  → schemas.<hash>.js (ES module; zod validators)
 *   `vite build`                 → runtime.<hash>.js (classic IIFE, injected as a
 *     plain <script>) + runtime.manifest.json in the Vite manifest shape that
 *     content/app.ts reads: entry "src/index.ts" with both lazy chunks as
 *     dynamic imports (so the content host serves them).
 */
const dist = join(import.meta.dirname, "dist");
const hash = (s: string) =>
  createHash("sha256").update(s).digest("base64url").slice(0, 10);

/** Renames the single emitted chunk to `<name>.<content hash>.js`. */
const hashed = (name: string, after?: (file: string) => void): Plugin => ({
  name: `oa-hash-${name}`,
  generateBundle(_, bundle) {
    for (const [k, c] of Object.entries(bundle)) {
      if (c.type !== "chunk") continue;
      delete bundle[k];
      const fileName = `${name}.${hash(c.code)}.js`;
      this.emitFile({ type: "asset", fileName, source: c.code });
      after?.(fileName);
    }
  },
});

// @oa/shared modules are side-effect free: a chunk only pulls the modules it uses.
const treeshake = {
  moduleSideEffects: (id: string) => !/[\\/]packages[\\/]shared[\\/]/.test(id),
};

// Not lib mode: Vite skips whitespace minification for ES libraries.
const esChunk = (name: string): UserConfig => ({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: name === "snapshot",
    target: "es2022",
    modulePreload: false,
    rollupOptions: {
      input: `src/${name}.ts`,
      preserveEntrySignatures: "exports-only",
      output: { format: "es" },
      treeshake,
    },
  },
  plugins: [hashed(name)],
});

const built = (name: string): string => {
  const f = readdirSync(dist).find((x) =>
    new RegExp(`^${name}\\.[\\w-]+\\.js$`).test(x),
  );
  if (!f) throw new Error(`build ${name} first (vite build --mode ${name})`);
  return f;
};

export default defineConfig(({ mode }): UserConfig => {
  if (mode === "snapshot" || mode === "schemas") return esChunk(mode);
  const snap = built("snapshot");
  const schemas = built("schemas");
  return {
    publicDir: false,
    define: {
      __OA_SNAPSHOT__: JSON.stringify(`./${snap}`),
      __OA_SCHEMAS__: JSON.stringify(`./${schemas}`),
    },
    build: {
      outDir: "dist",
      emptyOutDir: false,
      target: "es2020",
      lib: {
        entry: "src/index.ts",
        formats: ["iife"],
        name: "OpenArtifactsRuntime",
        fileName: "runtime",
      },
      rollupOptions: { treeshake },
    },
    plugins: [
      hashed("runtime", (file) =>
        writeFileSync(
          join(dist, "runtime.manifest.json"),
          `${JSON.stringify(
            {
              "src/index.ts": {
                file,
                src: "src/index.ts",
                isEntry: true,
                dynamicImports: ["src/schemas.ts", "src/snapshot.ts"],
              },
              "src/schemas.ts": {
                file: schemas,
                src: "src/schemas.ts",
                isDynamicEntry: true,
              },
              "src/snapshot.ts": {
                file: snap,
                src: "src/snapshot.ts",
                isDynamicEntry: true,
              },
            },
            null,
            2,
          )}\n`,
        ),
      ),
    ],
  };
});
