import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import type { SpaceRef } from "../api/contract";
import { useHosted } from "../auth/permissions";
import { useMe } from "../auth/useMe";

export interface CurrentSpace {
  /** The space the URL names, when it is one the caller can filter by. */
  space: SpaceRef | null;
  /** `?space=<id>` on the current route; no id removes it. */
  set(id?: string): void;
}

/**
 * The library's space filter, read from `?space=`. It resolves only from
 * `/me` (`personalSpaceId` and `spaces`): an id that is neither the caller's
 * personal space nor one of their shared spaces is cleared from the URL, with
 * no lookup request. Nothing is resolved while the `spaces` feature is off.
 *
 * Only on the library's routes: elsewhere `?space=` belongs to that page
 * (/settings/spaces?space=<id> names spaces the caller may have no role in),
 * and the header search, mounted everywhere, must leave it alone.
 */
const LIBRARY = new Set(["/", "/mine", "/shared", "/team", "/search"]);

export const useCurrentSpace = (): CurrentSpace => {
  const { features, spaces, personalSpaceId } = useHosted();
  const me = useMe();
  const raw = useSearch({ strict: false }) as { space?: string };
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const id = LIBRARY.has(path.toLowerCase().replace(/\/+$/, "") || "/")
    ? raw.space
    : undefined;

  const space = useMemo((): SpaceRef | null => {
    if (!id || !features.includes("spaces")) return null;
    if (personalSpaceId && id === personalSpaceId)
      // Personal: the owner's effective name (user.name, as the contract says).
      return {
        id,
        kind: "personal",
        name: me.status === "authed" ? (me.me.user.name ?? "") : "",
        publicLinks: true,
      };
    const mine = spaces.find((s) => s.id === id);
    return mine
      ? {
          id: mine.id,
          kind: mine.kind,
          name: mine.name,
          publicLinks: mine.publicLinks,
        }
      : null;
  }, [id, features, personalSpaceId, spaces, me]);

  const set = useCallback(
    (next?: string) =>
      void navigate({
        to: ".",
        replace: true,
        search: ((p: Record<string, unknown>) => ({
          ...p,
          space: next || undefined,
        })) as never,
      }),
    [navigate],
  );

  // Only once /me has answered: before that, nothing is known to be unknown.
  const answered = me.status !== "loading";
  useEffect(() => {
    if (id && !space && features.includes("spaces") && answered) set();
  }, [id, space, features, answered, set]);

  return { space, set };
};
