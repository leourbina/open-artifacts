import type { Hono } from "hono";
import type { AppEnv } from "../http/middleware.js";
import { mountAuth } from "./auth.js";

export type AppType = Hono<AppEnv>;

// Route groups (one file per R.* group) are mounted here by later tasks.
// Called before the SPA fallback, which is always registered last.
export function mountRoutes(app: AppType): void {
  mountAuth(app);
}
