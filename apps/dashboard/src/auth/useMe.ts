import { type Me, MeSchema, R } from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { ApiClientError, api } from "../api/client";
import { qk } from "../api/queries";

export type MeState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "error"; error: unknown }
  | { status: "authed"; me: Me };

/** A 401 means anonymous, even over stale data (expired session); other failures are `error`. */
export function useMe(): MeState {
  const q = useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => api.get(R.me, MeSchema, signal),
    staleTime: 60_000,
  });
  if (q.error instanceof ApiClientError && q.error.status === 401)
    return { status: "anonymous" };
  if (q.data) return { status: "authed", me: q.data };
  if (q.error) return { status: "error", error: q.error };
  return { status: "loading" };
}
