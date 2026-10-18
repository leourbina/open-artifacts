import { type Settings, SettingsSchema } from "@oa/shared";
import { Banner, Button, Input, SegmentedControl } from "@oa/ui";
import { useState } from "react";
import { useSettings, useUpdateSettings } from "../api/queries";
import { useDocumentTitle } from "../layout/useDocumentTitle";

const VISIBILITY = [
  { value: "private", label: "Private" },
  { value: "team", label: "Team" },
] as const;
const NAME_MAX = 80;
const HELP = {
  private: "Only the creator and the people they share with.",
  team: "Everyone on this instance can find and open it.",
};

export function Instance() {
  useDocumentTitle("Instance");
  const settings = useSettings();
  const update = useUpdateSettings();
  // Only edited fields live here; everything else reads through from the server.
  const [draft, setDraft] = useState<Partial<Settings>>({});
  // Local, not `saving`: it must lock the form in the same render as the click.
  const [saving, setSaving] = useState(false);
  if (settings.isError && !settings.data)
    return (
      <Banner
        tone="danger"
        title="Couldn't load instance settings"
        action={
          <Button variant="secondary" onClick={() => void settings.refetch()}>
            Retry
          </Button>
        }
      />
    );
  if (!settings.data) return <p aria-busy="true">Loading…</p>;
  const server = settings.data;
  const name = draft.name ?? server.name;
  const visibility = draft.defaultVisibility ?? server.defaultVisibility;
  const patch: Partial<Settings> = {};
  const trimmed = name.trim();
  const nameOk = trimmed.length >= 1 && trimmed.length <= NAME_MAX;
  if (draft.name !== undefined && trimmed !== server.name) patch.name = trimmed;
  if (
    draft.defaultVisibility !== undefined &&
    draft.defaultVisibility !== server.defaultVisibility
  )
    patch.defaultVisibility = draft.defaultVisibility;
  const dirty = Object.keys(patch).length > 0;
  const valid = nameOk && SettingsSchema.partial().safeParse(patch).success;
  const save = () => {
    setSaving(true);
    // Success or failure, drop the draft: the refetch shows the truth (a rollback on error).
    update.mutate(patch, {
      onSettled: () => {
        setSaving(false);
        setDraft({});
      },
    });
  };
  return (
    <form
      className="oa-card oa-instance"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && valid) save();
      }}
    >
      {settings.isError && (
        <Banner tone="warning" title="Couldn't refresh settings.">
          Showing the last loaded values. Your edits are kept.
        </Banner>
      )}
      <div className="oa-frow">
        <div className="oa-flabel">
          <label htmlFor="oa-inst-name">Instance name</label>
          <small>Shown in the sidebar and on the sign-in page.</small>
        </div>
        <div>
          <Input
            id="oa-inst-name"
            value={name}
            maxLength={NAME_MAX}
            disabled={saving}
            aria-describedby={nameOk ? undefined : "oa-inst-name-err"}
            placeholder="e.g. Northwind Eng"
            aria-invalid={!nameOk || undefined}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          {!nameOk && (
            <p className="oa-err" id="oa-inst-name-err" role="alert">
              Name must be 1 to {NAME_MAX} characters.
            </p>
          )}
        </div>
      </div>
      <div className="oa-frow">
        <div className="oa-flabel">
          <b>Default visibility</b>
          <small>
            For new artifacts from agents and uploads. Public is always chosen
            per artifact.
          </small>
        </div>
        <fieldset className="oa-bare" disabled={saving}>
          <SegmentedControl
            aria-label="Default visibility"
            options={[...VISIBILITY]}
            value={visibility}
            onChange={(v) => setDraft({ ...draft, defaultVisibility: v })}
          />
          <p className="oa-seen">{HELP[visibility]}</p>
        </fieldset>
      </div>
      <div className="oa-form-foot">
        <Button
          variant="ghost"
          type="button"
          disabled={!Object.keys(draft).length || saving}
          onClick={() => setDraft({})}
        >
          Discard
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={!dirty || !valid || saving}
        >
          Save changes
        </Button>
      </div>
    </form>
  );
}
