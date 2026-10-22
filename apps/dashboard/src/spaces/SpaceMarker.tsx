// The space marker on a card or row (Design D3, Spaces A): the space's name,
// or "Personal" for the caller's own, shown only in the cross-space Library.
// Also the interim visibility hints (Design, 2026-10-22): Team is everyone at
// the org who isn't a guest; Private in a shared space is the space's people.
import type { Visibility } from "@oa/shared";
import { VisibilityBadge } from "@oa/ui";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import type { SpaceRef } from "../api/contract";
import { useHosted } from "../auth/permissions";
import { useMe } from "../auth/useMe";
import { META } from "../library/ui";

/** What a visibility means here, or null when the label says it all. */
export const visibilityHint = (
  v: Visibility,
  space: Pick<SpaceRef, "kind" | "name"> | undefined,
  org: string,
): string | null => {
  if (!space) return null; // self-hosted: no spaces, no hints
  if (v === "team") return `Everyone at ${org}`;
  if (v === "private" && space.kind === "shared")
    return `People with access to ${space.name}`;
  return null;
};

/** The visibility badge, with its hint on hover where it has one. */
export function VisibilityWithHint({
  visibility,
  space,
}: {
  visibility: Visibility;
  space?: SpaceRef;
}) {
  const me = useMe();
  // No org name in the contract yet: the install name stands in.
  const org = me.status === "authed" ? me.me.instance.name : "";
  const hint = visibilityHint(visibility, space, org);
  if (!hint) return <VisibilityBadge visibility={visibility} />;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <VisibilityBadge visibility={visibility} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The chip: the space's name, "Personal" for mine, nothing for someone else's personal space. */
export function SpaceMarker({ space }: { space?: SpaceRef }) {
  const { personalSpaceId } = useHosted();
  if (!space) return null;
  const label =
    space.kind === "shared"
      ? space.name
      : space.id === personalSpaceId
        ? "Personal"
        : null;
  if (!label) return null;
  return (
    <span
      data-space-marker=""
      className={`inline-flex max-w-[160px] items-center truncate rounded-sm bg-[var(--oa-surface-2)] px-[6px] py-[1px] ${META}`}
    >
      {label}
    </span>
  );
}
