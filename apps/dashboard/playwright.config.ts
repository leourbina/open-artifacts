import { defineConfig } from "@playwright/test";

const port = 5199;

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: `http://localhost:${port}`, browserName: "chromium" },
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    env: { VITE_MOCK: "1" },
    reuseExistingServer: false,
  },
});
