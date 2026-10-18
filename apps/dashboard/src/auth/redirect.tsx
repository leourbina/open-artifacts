import { AUTH } from "@oa/shared";
import { createContext, useContext, useEffect } from "react";

export type Redirect = (url: string) => void;

const hardRedirect: Redirect = (url) => window.location.assign(url);

const RedirectContext = createContext<Redirect>(hardRedirect);

/** Full-page navigation hook; tests swap it for a spy. */
export const RedirectProvider = RedirectContext.Provider;
export const useRedirect = () => useContext(RedirectContext);

/** Sends the visitor to sign in (returning to `next`) once `when` holds. */
export function useLoginRedirect(when: boolean, next: string) {
  const redirect = useRedirect();
  useEffect(() => {
    if (when) redirect(`${AUTH.login}?next=${encodeURIComponent(next)}`);
  }, [when, redirect, next]);
}
