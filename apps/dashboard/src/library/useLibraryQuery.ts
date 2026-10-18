import { ArtifactSummarySchema, type Format, PageSchema, R } from "@oa/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { qk } from "../api/queries";

export type Scope = "all" | "mine" | "shared" | "team";
export type LibraryFilters = { scope: Scope; format?: Format; agent?: string };

const ArtifactPage = PageSchema(ArtifactSummarySchema);

export const useLibraryQuery = (f: LibraryFilters) =>
  useInfiniteQuery({
    queryKey: [...qk.artifacts(f), "pages"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ scope: f.scope });
      if (f.format) p.set("format", f.format);
      if (f.agent) p.set("agent", f.agent);
      if (pageParam) p.set("cursor", pageParam);
      return api.get(`${R.artifacts}?${p}`, ArtifactPage, signal);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
