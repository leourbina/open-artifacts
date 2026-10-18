import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://open-artifacts.com",
  output: "static",
  build: { format: "directory", inlineStylesheets: "always" },
});
