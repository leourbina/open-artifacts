import { createContext, useContext } from "react";

export type Redirect = (url: string) => void;

const hardRedirect: Redirect = (url) => window.location.assign(url);

const RedirectContext = createContext<Redirect>(hardRedirect);

/** Full-page navigation hook; tests swap it for a spy. */
export const RedirectProvider = RedirectContext.Provider;
export const useRedirect = () => useContext(RedirectContext);
