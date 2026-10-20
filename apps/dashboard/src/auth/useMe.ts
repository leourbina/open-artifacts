import { type Me, MeSchema, R } from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { ApiClientError, api } from "../api/client";
import { qk } from "../api/queries";
import { isEmbed } from "../embed";

export type MeState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "error"; error: unknown }
  | { status: "authed"; me: Me };

/** A 401 means anonymous, even over stale data (expired session); other failures are `error`.
    Framed (embed mode), always anonymous and never fetched. */
export function useMe(): MeState {
  const embed = isEmbed();
  const q = useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => api.get(R.me, MeSchema, signal),
    staleTime: 60_000,
    enabled: !embed,
  });
  if (embed) return { status: "anonymous" };
  if (q.error instanceof ApiClientError && q.error.status === 401)
    return { status: "anonymous" };
  if (q.data) return { status: "authed", me: q.data };
  if (q.error) return { status: "error", error: q.error };
  return { status: "loading" };
}
