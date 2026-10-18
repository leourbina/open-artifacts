import { R } from "@oa/shared";
import { requireUser } from "../auth/authz.js";
import { ApiError } from "../http/errors.js";
import { getUsage } from "../services/usage.js";
import type { AppType } from "./index.js";

export function mountUsage(app: AppType): void {
  app.get(R.usage, async (c) => {
    const user = requireUser(c);
    if (user.role !== "owner" && user.role !== "admin")
      throw new ApiError("not_found", "Not found");
    return c.json(await getUsage(c.env));
  });
}
