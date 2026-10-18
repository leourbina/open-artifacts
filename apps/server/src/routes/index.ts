import type { Hono } from "hono";
import type { Env } from "../env.js";

export type AppType = Hono<{ Bindings: Env }>;

// Route groups (one file per R.* group) are mounted here by later tasks.
// Called before the SPA fallback, which is always registered last.
export function mountRoutes(_app: AppType): void {}
