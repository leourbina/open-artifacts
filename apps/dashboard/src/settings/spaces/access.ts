import type { Me } from "@oa/shared";
import { hasFeature } from "../../api/contract";

/** Org owners and admins. */
export const isOrgAdmin = (me: Me | null | undefined) =>
  me?.user.role === "owner" || me?.user.role === "admin";

/**
 * Who reaches /settings/spaces: hosted (the spaces feature), and an org admin
 * or a member who manages at least one shared space.
 */
export const canAdminSpaces = (me: Me | null | undefined) =>
  !!me &&
  hasFeature(me, "spaces") &&
  (isOrgAdmin(me) ||
    (me.user.role === "member" &&
      (me.spaces ?? []).some((s) => s.myRole === "manager")));
