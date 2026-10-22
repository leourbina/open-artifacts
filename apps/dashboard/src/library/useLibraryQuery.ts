import { ArtifactSummarySchema, type Format, PageSchema, R } from "@oa/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { qk } from "../api/queries";
import { useHosted } from "../auth/permissions";

export type Scope = "all" | "mine" | "shared" | "team";
export type LibraryFilters = {
  scope: Scope;
  format?: Format;
  agent?: string;
  /** A space id from `?space=`; the caller's personal space reads as `mine`. */
  space?: string;
};

const ArtifactPage = PageSchema(ArtifactSummarySchema);

export const useLibraryQuery = (f: LibraryFilters) => {
  const { personalSpaceId } = useHosted();
  return useInfiniteQuery({
    // qk.artifacts parses the core list query, which drops `space`: add it.
    queryKey: [...qk.artifacts(f), f.space ?? "", "pages"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const mine = f.space !== undefined && f.space === personalSpaceId;
      // Inside a space the tabs still apply: spaceId narrows any scope.
      const scope =
        f.space === undefined
          ? f.scope
          : f.scope === "all"
            ? mine
              ? "mine"
              : "space"
            : f.scope;
      const p = new URLSearchParams({ scope });
      if (f.space && !(mine && scope === "mine")) p.set("spaceId", f.space);
      if (f.format) p.set("format", f.format);
      if (f.agent) p.set("agent", f.agent);
      if (pageParam) p.set("cursor", pageParam);
      return api.get(`${R.artifacts}?${p}`, ArtifactPage, signal);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
};
