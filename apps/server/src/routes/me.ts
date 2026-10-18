import { MCP_PATH, type Me, R } from "@oa/shared";
import { requireUser } from "../auth/authz.js";
import { appOrigin } from "../http/errors.js";
import { getSettings } from "../services/members.js";
import type { AppType } from "./index.js";

export function mountMe(app: AppType): void {
  app.get(R.me, async (c) => {
    const user = requireUser(c);
    const s = await getSettings(c.env);
    const appUrl = appOrigin(c.env);
    const me: Me = {
      user,
      instance: {
        name: s.name,
        defaultVisibility: s.defaultVisibility,
        appUrl,
        mcpUrl: appUrl + MCP_PATH,
      },
    };
    return c.json(me);
  });
}
