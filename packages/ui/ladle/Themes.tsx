import type { CSSProperties, ReactNode } from "react";
import "../src/tokens/tokens.css";
import { tokens } from "../src/tokens/index";

const vars = (theme: "light" | "dark") =>
  Object.fromEntries(
    Object.entries(tokens).map(([k, v]) => [`--oa-${k}`, v[theme]]),
  ) as CSSProperties;

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
