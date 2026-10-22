import { PageSchema, R, SearchHitSchema } from "@oa/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { qk } from "../api/queries";
import { useCurrentSpace } from "../spaces/useCurrentSpace";

const SearchPage = PageSchema(SearchHitSchema);

/** `q` must already be trimmed; an empty query makes no request. */
export const useSearchQuery = (q: string) => {
  const space = useCurrentSpace().space;
  return useInfiniteQuery({
    queryKey: [...qk.search({ q }), space?.id ?? "", "pages"],
    enabled: q.length > 0,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ q });
      if (space) p.set("spaceId", space.id);
      if (pageParam) p.set("cursor", pageParam);
      return api.get(`${R.search}?${p}`, SearchPage, signal);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
};
