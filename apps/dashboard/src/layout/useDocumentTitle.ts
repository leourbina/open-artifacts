import { useEffect } from "react";

const APP = "Open Artifacts";

/**
 * Sets `document.title` to "<page> · Open Artifacts" while mounted. `null` leaves
 * it alone, so a page still loading never overrides a child (e.g. NotFound).
 */
export function useDocumentTitle(page: string | null) {
  useEffect(() => {
    if (!page) return;
    document.title = `${page} · ${APP}`;
    return () => {
      document.title = APP;
    };
  }, [page]);
}
