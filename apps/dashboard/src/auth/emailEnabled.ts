import type { Me } from "@oa/shared";

/** Whether this instance sends invite and share emails. */
export const emailEnabled = (me: Me | null | undefined) =>
  me?.instance.emailEnabled ?? false;
