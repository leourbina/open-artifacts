import type { Theme } from "@oa/shared";
import { onShellMessage } from "./shell";

const listeners = new Set<(t: Theme) => void>();
let shellSet = false;
let last: Theme | null = null;

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** The shell's theme (data-theme on <html>) once set; until then prefers-color-scheme. */
export function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  if (shellSet && (set === "light" || set === "dark")) return set;
  return systemTheme();
}

function notify(): void {
  const t = currentTheme();
  if (t === last) return;
  last = t;
  for (const fn of listeners) fn(t);
}

/** A theme from the shell: pinned as data-theme on <html> (the D5 contract). */
export function applyTheme(theme: Theme): void {
  last ??= currentTheme();
  shellSet = true;
  document.documentElement.dataset.theme = theme;
  notify();
}

export function onThemeChange(fn: (t: Theme) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Until the shell sends a theme, leave data-theme unset (theme.css follows the
 * media query) and tell listeners when prefers-color-scheme flips.
 */
export function followSystemTheme(): () => void {
  last ??= currentTheme();
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq) return () => {};
  const onChange = () => {
    if (!shellSet) notify();
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Follows the shell's welcome/theme messages. */
export function watchShellTheme(): () => void {
  return onShellMessage((msg) => {
    if (msg.type === "welcome" || msg.type === "theme") applyTheme(msg.theme);
  });
}

export function resetThemeForTests(): void {
  shellSet = false;
  last = null;
  listeners.clear();
}
