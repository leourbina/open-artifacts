// URLs of the brand SVGs; bundlers (Vite) resolve these as assets.
const asset = (name: string): string =>
  new URL(`./${name}`, import.meta.url).href;

export const brand = {
  /** Frame uses currentColor; accent reads --oa-brand-accent, then --oa-accent. */
  mark: asset("mark.svg"),
  markLight: asset("mark-light.svg"),
  markDark: asset("mark-dark.svg"),
  markOnAccent: asset("mark-on-accent.svg"),
  logo: asset("logo.svg"),
  logoDark: asset("logo-dark.svg"),
  /** 16px-tuned; switches to dark ink under prefers-color-scheme: dark. */
  favicon: asset("favicon.svg"),
} as const;
