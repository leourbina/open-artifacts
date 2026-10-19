import { useSyncExternalStore } from "react";

export type DataTheme = "light" | "dark";

const DARK = "(prefers-color-scheme: dark)";

/** The Studio theme rule (tokens.css): <html data-theme>, else the OS. */
function current(): DataTheme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia?.(DARK).matches ? "dark" : "light";
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const media = window.matchMedia?.(DARK);
  media?.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener("change", onChange);
  };
}

/** Replaces next-themes' useTheme() for shadcn components (e.g. sonner). */
export function useDataTheme(): DataTheme {
  return useSyncExternalStore(subscribe, current, () => "light");
}
