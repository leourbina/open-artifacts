import type { Hono } from "hono";
import type { AppEnv } from "../http/middleware.js";
import { mountArtifacts } from "./artifacts.js";
import { mountAuth } from "./auth.js";
import { mountMe } from "./me.js";
import { mountMembers } from "./members.js";
import { mountSettings } from "./settings.js";
import { mountShares } from "./shares.js";
import { mountUploads } from "./uploads.js";

export type AppType = Hono<AppEnv>;

// Route groups (one file per R.* group) are mounted here by later tasks.
// Called before the SPA fallback, which is always registered last.
export function mountRoutes(app: AppType): void {
  mountAuth(app);
  mountMe(app);
  mountMembers(app);
  mountSettings(app);
  mountArtifacts(app);
  mountUploads(app);
  mountShares(app);
}
