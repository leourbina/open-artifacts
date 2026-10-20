import { defineConfig } from "vitest/config";

/** Source checks that need Node (fs, the TypeScript compiler), not workerd. */
export default defineConfig({
  test: {
    include: ["test/node/**/*.test.ts"],
    environment: "node",
  },
});
