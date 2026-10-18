import { useEffect, useRef } from "react";

type Paged = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
};

/** Ref for a sentinel element; fetches the next page when it scrolls into view. */
export function useSentinel({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: Paged) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (
        entries.some((e) => e.isIntersecting) &&
        hasNextPage &&
        !isFetchingNextPage
      )
        void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return ref;
}

/** Flatten pages, dropping repeats (an item can shift across a page boundary). */
export function uniqueItems<T extends { id: string }>(
  pages: { items: T[] }[] | undefined,
): T[] {
  const seen = new Set<string>();
  return (pages ?? []).flatMap((p) =>
    p.items.filter((a) => !seen.has(a.id) && seen.add(a.id)),
  );
}
