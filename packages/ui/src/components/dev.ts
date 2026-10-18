import { useEffect } from "react";

type Env = { process?: { env?: Record<string, string | undefined> } };

/** Vite's DEV flag, else NODE_ENV, else assume production. */
export function isDev(): boolean {
  const viteDev = import.meta.env?.DEV;
  if (typeof viteDev === "boolean") return viteDev;
  const env = (globalThis as Env).process?.env;
  return env ? env.NODE_ENV !== "production" : false;
}

/** Logs once per mount (and on change), in development only. */
export function useDevError(
  failed: boolean,
  message: string,
  level: "error" | "warn" = "error",
) {
  useEffect(() => {
    if (isDev() && failed) console[level](message);
  }, [failed, message, level]);
}
