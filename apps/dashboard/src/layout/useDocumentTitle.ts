import { useEffect } from "react";
import { useMe } from "../auth/useMe";

const APP = "Open Artifacts";

/**
 * Sets `document.title` to "<page> · <instance name>" while mounted (the name
 * comes from /me, else "Open Artifacts"). `null` leaves it alone, so a page
 * still loading never overrides a child (e.g. NotFound).
 */
export function useDocumentTitle(page: string | null) {
  const state = useMe();
  const name = (state.status === "authed" && state.me.instance.name) || APP;
  useEffect(() => {
    if (!page) return;
    document.title = `${page} · ${name}`;
    return () => {
      document.title = name;
    };
  }, [page, name]);
}
