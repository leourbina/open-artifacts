import { AUTH } from "@oa/shared";
import { createContext, useContext, useEffect } from "react";
import { isEmbed, openInNewTab } from "../embed";

export type Redirect = (url: string) => void;

/** Framed, the frame never leaves its page: the target opens in a new tab. */
const hardRedirect: Redirect = (url) =>
  isEmbed() ? openInNewTab(url) : window.location.assign(url);

const RedirectContext = createContext<Redirect>(hardRedirect);

/** Full-page navigation hook; tests swap it for a spy. */
export const RedirectProvider = RedirectContext.Provider;
export const useRedirect = () => useContext(RedirectContext);

/** Sends the visitor to sign in (returning to `next`) once `when` holds.
    Never framed: the caller shows the not-public panel instead. */
export function useLoginRedirect(when: boolean, next: string) {
  const redirect = useRedirect();
  useEffect(() => {
    if (when && !isEmbed())
      redirect(`${AUTH.login}?next=${encodeURIComponent(next)}`);
  }, [when, redirect, next]);
}
