// The "Space" select in the upload dialog (Design D4, 2026-10-22): Personal
// first, then the shared spaces you can publish to, by name. Spaces you can't
// publish to are hidden (canPublishTo); a capped caller gets none.
import { Select } from "@oa/ui";
import { useId } from "react";
import { canPublishTo, useHosted } from "../auth/permissions";

export function SpacePicker({
  value,
  onChange,
  label = "Space",
}: {
  value: string | undefined;
  onChange: (id: string) => void;
  label?: string;
}) {
  const { spaces, personalSpaceId, cap } = useHosted();
  const id = useId();
  const options = [
    ...(personalSpaceId && canPublishTo({ kind: "personal", myRole: null }, cap)
      ? [{ value: personalSpaceId, label: "Personal" }]
      : []),
    ...spaces
      .filter((s) => canPublishTo(s, cap))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ value: s.id, label: s.name })),
  ];
  return (
    <div>
      <span id={`${id}-label`} className="up-entry-label">
        {label}
      </span>
      <Select
        aria-labelledby={`${id}-label`}
        options={options}
        value={value}
        onChange={onChange}
        placeholder="Choose a space"
      />
      <small id={`${id}-help`} className="up-help">
        People in this space get access by their role.
      </small>
    </div>
  );
}

/** Where an upload starts: the open space when you can publish there, else Personal. */
export const useUploadSpace = (current: string | undefined) => {
  const { spaces, personalSpaceId, cap } = useHosted();
  if (current && current === personalSpaceId) return personalSpaceId;
  const s = current ? spaces.find((x) => x.id === current) : undefined;
  return s && canPublishTo(s, cap) ? s.id : (personalSpaceId ?? undefined);
};
