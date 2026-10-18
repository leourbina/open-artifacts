import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const read = (): Theme => {
  const t = document.documentElement.dataset.theme;
  if (t === "light" || t === "dark") return t;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

/** Effective theme: `[data-theme]` on <html> wins over the OS preference. */
export function useTheme(): Theme {
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const update = () => setTheme(read());
    const mq = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    mq?.addEventListener("change", update);
    update();
    return () => {
      mo.disconnect();
      mq?.removeEventListener("change", update);
    };
  }, []);
  return theme;
}
