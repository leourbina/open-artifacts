import type { CSSProperties, ReactNode } from "react";
import "../src/tokens/tokens.css";
import { tokens } from "../src/tokens/index";

// Shadows reference --oa-border, which :root resolves once; redeclare them
// per panel (values mirror tokens.css) so the dark panel gets dark borders.
const shadows = {
  light: {
    "--oa-shadow-1":
      "0 1px 0 rgba(20, 24, 30, 0.04), 0 0 0 1px var(--oa-border)",
    "--oa-shadow-2":
      "0 0 0 1px var(--oa-border-strong), 0 4px 14px rgba(20, 24, 30, 0.06)",
  },
  dark: {
    "--oa-shadow-1": "0 0 0 1px var(--oa-border)",
    "--oa-shadow-2":
      "0 0 0 1px var(--oa-border-strong), 0 4px 14px rgba(0, 0, 0, 0.4)",
  },
};

const vars = (theme: "light" | "dark") =>
  ({
    ...Object.fromEntries(
      Object.entries(tokens).map(([k, v]) => [`--oa-${k}`, v[theme]]),
    ),
    ...shadows[theme],
  }) as CSSProperties;

/** Renders the story twice, light and dark, side by side. */
export function Themes({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
      {(["light", "dark"] as const).map((theme) => (
        <div
          key={theme}
          data-theme={theme}
          style={{
            ...vars(theme),
            colorScheme: theme,
            background: "var(--oa-bg)",
            color: "var(--oa-text)",
            fontFamily: "var(--oa-font-sans)",
            padding: 24,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 12,
          }}
        >
          {children}
        </div>
      ))}
    </div>
  );
}
