import { MCP_PATH, type Me, type Member, MePatchSchema, R } from "@oa/shared";
import type { Context } from "hono";
import { requireUser } from "../auth/authz.js";
import { emailEnabled } from "../email/send.js";
import { jsonBody } from "../http/body.js";
import { appOrigin } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import { getSettings } from "../services/members.js";
import { getProfile, type Profile, setDisplayName } from "../services/users.js";
import type { AppType } from "./index.js";

async function toMe(
  c: Context<AppEnv>,
  user: Member,
  profile: Profile,
): Promise<Me> {
  const s = await getSettings(c.env);
  const appUrl = appOrigin(c.env);
  return {
    user,
    instance: {
      name: s.name,
      defaultVisibility: s.defaultVisibility,
      appUrl,
      mcpUrl: appUrl + MCP_PATH,
      emailEnabled: emailEnabled(c.env),
    },
    ...profile,
  };
}

export function mountMe(app: AppType): void {
  app.get(R.me, async (c) => {
    const user = requireUser(c);
    return c.json(await toMe(c, user, await getProfile(c.env, user.id)));
  });

  // Session (CSRF-guarded by csrf() in createApp) or PAT; guests included.
  app.patch(R.me, async (c) => {
    const user = requireUser(c);
    const { displayName } = await jsonBody(c, MePatchSchema);
    const { member, profile } = await setDisplayName(
      c.env,
      user.id,
      displayName,
    );
    return c.json(await toMe(c, member, profile));
  });
}
