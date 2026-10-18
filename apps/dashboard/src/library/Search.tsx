import { EmptyState, Skeleton } from "@oa/ui";
import { useSearch as useRouteSearch } from "@tanstack/react-router";
import { ArtifactRow } from "./ArtifactRow";
import { SearchIcon } from "./icons";
import "./library.css";
import { uniqueItems, useSentinel } from "./useInfinite";
import { useSearchQuery } from "./useSearchQuery";

export function SearchPage() {
  const raw = useRouteSearch({ strict: false }) as { q?: string };
  const q = (raw.q ?? "").trim();
  const r = useSearchQuery(q);
  const sentinel = useSentinel(r);
  const items = uniqueItems(r.data?.pages);
  return (
    <section className="lib">
      <h1>Search</h1>
      {!q && (
        <EmptyState
          icon={<SearchIcon />}
          title="Search your artifacts"
          description="Type in the search box to find titles, content, and agents."
        />
      )}
      {r.isError && (
        <div className="lib-error" role="alert">
          Search failed. Try again.
        </div>
      )}
      {q && r.isPending && !r.isError && (
        <div className="lib-list" role="status" aria-label="Searching">
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      )}
      {r.isSuccess && items.length === 0 && (
        <EmptyState
          icon={<SearchIcon />}
          title={`No results for “${q}”`}
          description="Try different words, or check the spelling."
        />
      )}
      <div className="lib-list">
        {items.map((a) => (
          <ArtifactRow key={a.id} artifact={a} snippet={a.snippet} />
        ))}
      </div>
      <div ref={sentinel} className="lib-sentinel" />
    </section>
  );
}
