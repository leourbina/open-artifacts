import type { Me, Member, TransferSummary } from "@oa/shared";
import { R } from "@oa/shared";
import { useQueries } from "@tanstack/react-query";
import { api } from "../api/client";
import { hasFeature, TransferSummarySchema } from "../api/contract";
import { qk, useMembers } from "../api/queries";

export type Departed = { member: Member; summary: TransferSummary };

/** Org owners and admins on a hosted install: who may see departed people. */
export const seesDeparted = (me: Me | null | undefined) =>
  !!me &&
  hasFeature(me, "spaces") &&
  (me.user.role === "owner" || me.user.role === "admin");

/**
 * Suspended or removed members who still have personal artifacts, with their
 * counts (never titles: only R.memberTransfer, never their artifacts).
 * People with nothing left are left out.
 */
export const useDeparted = (me: Me | null | undefined): Departed[] => {
  const on = seesDeparted(me);
  const people = useMembers("suspended,removed", on);
  const summaries = useQueries({
    queries: (on ? (people.data ?? []) : []).map((m) => ({
      queryKey: qk.memberTransfer(m.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get(R.memberTransfer(m.id), TransferSummarySchema, signal),
    })),
  });
  const list = on ? (people.data ?? []) : [];
  return list.flatMap((member, i) => {
    const summary = summaries[i]?.data;
    return summary && summary.live + summary.deleted > 0
      ? [{ member, summary }]
      : [];
  });
};
