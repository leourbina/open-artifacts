import type { ComponentProps, CSSProperties, ReactNode } from "react";
import type { Visibility } from "../types";
import { cx } from "./cx";
import s from "./Display.module.css";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  return <span className={cx(s.badge, s[tone])}>{children}</span>;
}

/** FNV-1a over the normalized email, folded onto the color wheel. */
export function avatarHue(email: string): number {
  let h = 0x811c9dc5;
  for (const ch of email.normalize("NFC").trim().toLowerCase()) {
    h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 0x01000193);
  }
  return (h >>> 0) % 360;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string) =>
  Array.from(segmenter.segment(s), (g) => g.segment);
// Uppercasing can expand a grapheme (ß → SS), so cut again afterwards.
const two = (s: string) =>
  graphemes(graphemes(s).slice(0, 2).join("").toUpperCase())
    .slice(0, 2)
    .join("");

function initials(name: string | undefined, email: string) {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 0) {
    return two(
      words
        .slice(0, 2)
        .map((w) => graphemes(w)[0])
        .join(""),
    );
  }
  return two(email.trim().split("@")[0] ?? "") || "?";
}

export function Avatar({
  name,
  email,
  size = 24,
}: {
  name?: string;
  email: string;
  size?: 24 | 32;
}) {
  const style = {
    "--hue": avatarHue(email),
    "--size": `${size}px`,
  } as CSSProperties;
  return (
    <span
      role="img"
      aria-label={name?.trim() || email.trim() || "User"}
      className={s.avatar}
      style={style}
    >
      {initials(name, email)}
    </span>
  );
}

export const Kbd = (props: ComponentProps<"kbd">) => (
  <kbd {...props} className={cx(s.kbd, props.className)} />
);

export function Spinner({
  label = "Loading",
  decorative = false,
}: {
  label?: string;
  decorative?: boolean;
}) {
  return decorative ? (
    <span aria-hidden="true" className={s.spinner} />
  ) : (
    <span
      role="status"
      aria-label={label.trim() || "Loading"}
      className={s.spinner}
    />
  );
}

const glyph = (d: ReactNode, size: number, label?: string) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    className={s.icon}
    role={label ? "img" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
  >
    {d}
  </svg>
);

const visibility: Record<Visibility, [string, ReactNode]> = {
  private: [
    "Private",
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>,
  ],
  team: [
    "Team",
    <>
      <circle cx="6" cy="6" r="2.5" />
      <path d="M1.5 13.5c.5-2.5 2.3-3.8 4.5-3.8s4 1.3 4.5 3.8M11 3.8a2.3 2.3 0 0 1 0 4.4M12.5 10c1.2.6 1.8 1.8 2 3.5" />
    </>,
  ],
  public: [
    "Public",
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 2 2.6 4 2.6 6S9.8 12 8 14M8 2C6.2 4 5.4 6 5.4 8S6.2 12 8 14" />
    </>,
  ],
};

export function VisibilityBadge({ visibility: v }: { visibility: Visibility }) {
  const [label, d] = visibility[v];
  return (
    <span className={cx(s.badge, s[`vis-${v}`])}>
      {glyph(d, 11)}
      {label}
    </span>
  );
}
