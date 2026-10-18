import type { Env as AppEnv } from "../src/env.js";

declare global {
  namespace Cloudflare {
    // biome-ignore lint/suspicious/noEmptyInterface: augment the test-runtime env with our bindings
    interface Env extends AppEnv {}
  }
}
