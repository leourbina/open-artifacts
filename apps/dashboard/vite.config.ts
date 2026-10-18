import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const target = "http://app.localhost:8787";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Resolve the workspace contract from source so no prior shared build is needed.
    alias: [
      {
        find: /^@oa\/shared$/,
        replacement: fileURLToPath(
          new URL("../../packages/shared/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@oa\/shared\/(.*)$/,
        replacement: `${fileURLToPath(new URL("../../packages/shared/src", import.meta.url))}/$1`,
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": target,
      "/auth": target,
      "/mcp": target,
      "/oauth": target,
      "/healthz": target,
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "node", include: ["test/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["test/**/*.test.tsx"],
          setupFiles: ["test/setup.ts"],
        },
      },
    ],
  },
});
