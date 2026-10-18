import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const target = "http://app.localhost:8787";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Resolve the workspace contract from source so no prior shared build is needed.
    alias: {
      "@oa/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": target,
      "/auth": target,
      "/mcp": target,
      "/oauth": target,
      "/healthz": target,
      // Artifact HTML only; SPA routes under /a/ stay with Vite.
      "/a": {
        target,
        bypass: (req) =>
          req.headers.accept?.includes("text/html") ? undefined : req.url,
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: { include: ["test/**/*.test.ts"] },
});
