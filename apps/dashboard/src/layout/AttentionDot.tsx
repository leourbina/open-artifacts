/** Appended to a link's name when its dot shows. */
export const ATTENTION = ", needs attention";

/** A small accent dot after a nav label; decorative (the name says it). */
export function AttentionDot() {
  return (
    <span
      aria-hidden="true"
      data-attention=""
      className="ml-auto size-[6px] flex-none rounded-full bg-[var(--oa-accent)]"
    />
  );
}
