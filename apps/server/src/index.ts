import { app } from "./app.js";
import { contentApp } from "./content/app.js";
import type { Env } from "./env.js";

export type { Env } from "./env.js";
export { ArtifactRuntime } from "./runtime/artifact-runtime.js";

const normHost = (h: string) =>
  h.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

export default {
  fetch(req, env, ctx) {
    // URL.hostname only: port stripped; X-Forwarded-Host is ignored.
    const isContent =
      normHost(new URL(req.url).hostname) === normHost(env.CONTENT_HOST);
    const target = isContent ? contentApp : app;
    return target.fetch(req, env, ctx);
  },
  async scheduled() {
    // cron.ts lands in B7
  },
} satisfies ExportedHandler<Env>;
