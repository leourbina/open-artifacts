// Shared layout for the library and search pages on @oa/ui/shadcn.
import type { ReactNode } from "react";

/** The page: header, tabs, filters and results, 16px apart. */
export const PAGE = "flex flex-col gap-[var(--oa-space-4)]";
/** Design's page h1: 20px, semibold. */
export const H1 = "m-0 text-[length:var(--oa-text-xl)] font-semibold";
export const BAR = "flex flex-wrap items-center gap-[var(--oa-space-2)]";
/** Auto-filling 240px columns; two columns on phones. */
export const GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-[var(--oa-space-4)] max-[600px]:grid-cols-2";
export const LIST = "flex flex-col gap-[var(--oa-space-2)]";
export const META = "text-[length:var(--oa-text-xs)] text-muted-foreground";
export const ALERT =
  "flex items-center gap-[var(--oa-space-3)] rounded-md border border-solid border-border p-[var(--oa-space-3)]";

/** A card or row is one link: the title's ::after covers it, other
    controls sit above, and keyboard focus rings the whole thing. */
export const STRETCH =
  "relative cursor-pointer [&_:is(button,a):not(.lib-title)]:relative [&_:is(button,a):not(.lib-title)]:z-[1] has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-solid has-[a:focus-visible]:outline-[var(--oa-focus)] motion-reduce:transition-none";
export const TITLE_LINK =
  "lib-title text-inherit no-underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none";

/** No results, no artifacts, or nothing searched yet. */
export function Empty({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-[var(--oa-space-2)] px-[var(--oa-space-4)] py-[var(--oa-space-8)] text-center">
      <div className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
        {icon}
      </div>
      <h2 className="mt-[var(--oa-space-2)] mb-0 text-[length:var(--oa-text-lg)] font-semibold">
        {title}
      </h2>
      <p className="m-0 mb-[var(--oa-space-2)] max-w-[360px] text-[length:var(--oa-text-sm)] text-[var(--oa-text-2)]">
        {description}
      </p>
    </div>
  );
}
