import { defineConfig } from "vite";

/**
 * ESM build of src/index.ts into a flat dist/ served verbatim under /_oa/ on
 * the content host. Hashed names + manifest.json (entry key "src/index.ts").
 */
export default defineConfig({
  base: "/_oa/",
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "",
    manifest: "manifest.json",
    target: "es2022",
    sourcemap: false,
    modulePreload: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: "src/index.ts",
      preserveEntrySignatures: "exports-only",
      output: {
        format: "es",
        entryFileNames: "render.[hash].js",
        chunkFileNames: "[name].[hash].js",
        assetFileNames: "[name].[hash][extname]",
      },
    },
  },
});
