import type { Env as DispatchEnv } from "../src/index.js";

declare global {
  namespace Cloudflare {
    // biome-ignore lint/suspicious/noEmptyInterface: augment the test-runtime env with our bindings
    interface Env extends DispatchEnv {}
  }
}
