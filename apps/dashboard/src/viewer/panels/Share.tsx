import {
  type ArtifactPatch,
  type ArtifactSummary,
  type ShareRole,
  ShareSchema,
  type Visibility,
  viewerPath,
} from "@oa/shared";
import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  displayName,
  Input,
  SegmentedControl,
  Select,
  toast,
  VisibilityBadge,
} from "@oa/ui";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import {
  useDeleteShare,
  usePatchArtifact,
  usePutShare,
  useShares,
} from "../../api/queries";

const VIS: { value: Visibility; label: string }[] = [
  { value: "private", label: "Private" },
  { value: "team", label: "Team" },
  { value: "public", label: "Public" },
];
const ROLES: { value: ShareRole; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
];
const NOTE: Record<Visibility, string> = {
  private: "Only you and the people below can open it.",
  team: "Everyone in the workspace can open it.",
  public: "Anyone with the link can view. It won't appear in search engines.",
};
const CAPS = [
  ["db", "Database"],
  ["viewer", "Viewer identity"],
  ["storage", "File storage"],
] as const;

const fail = (e: unknown, fallback: string) =>
  toast({
    title: e instanceof ApiClientError ? e.message : fallback,
    tone: "danger",
  });

/** Trimmed, lowercased, ASCII-only email, or null. */
export const parseEmail = (raw: string) => {
  const v = raw.trim().toLowerCase();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII check
  if (!/^[\x00-\x7f]+$/.test(v)) return null;
  const r = ShareSchema.shape.email.safeParse(v);
  return r.success ? r.data : null;
};

export function Share({ artifact }: { artifact: ArtifactSummary }) {
  const { id } = artifact;
  const owner = artifact.access === "owner";
  const shares = useShares(id);
  const patch = usePatchArtifact(id);
  const put = usePutShare(id);
  const del = useDeleteShare(id);
  const [confirmPublic, setConfirmPublic] = useState(false);
  // The control only stages a choice; Save visibility commits it.
  // Tagged with the visibility it was staged from, so a server change drops it.
  const [stage, setStage] = useState<{
    from: Visibility;
    to: Visibility;
  } | null>(null);
  const setPending = (to: Visibility | null) =>
    setStage(to && { from: artifact.visibility, to });
  const staged =
    stage?.from === artifact.visibility ? stage.to : artifact.visibility;
  const changed = staged !== artifact.visibility;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const [invalid, setInvalid] = useState(false);

  const save = (p: ArtifactPatch) =>
    patch.mutate(p, { onError: (e) => fail(e, "Couldn't save") });
  const commitVisibility = (v: Visibility) =>
    patch.mutate(
      {
        visibility: v,
        ...(artifact.allowAnonymousWrites && { allowAnonymousWrites: false }),
      },
      {
        onError: (e) => {
          setPending(null);
          fail(e, "Couldn't save");
        },
      },
    );
  const setCap = (k: (typeof CAPS)[number][0], on: boolean) =>
    save({
      capabilities: { [k]: on },
      ...(k === "db" && !on && artifact.allowAnonymousWrites
        ? { allowAnonymousWrites: false }
        : {}),
    });
  const invite = () => {
    const e = parseEmail(email);
    setInvalid(!e);
    if (!e) return;
    put.mutate(
      { email: e, role },
      {
        onSuccess: () => setEmail(""),
        onError: (x) => fail(x, "Couldn't invite"),
      },
    );
  };
  // location.origin is the app host, which is where viewerPath lives.
  const link = location.origin + viewerPath(id);
  const copy = () => {
    const failed = () =>
      toast({ title: "Couldn't copy", description: link, tone: "danger" });
    if (!navigator.clipboard) return failed();
    navigator.clipboard
      .writeText(link)
      .then(() => toast({ title: "Link copied", tone: "success" }), failed);
  };

  return (
    <div className="oa-share">
      <section>
        <h3 id="oa-share-vis">Visibility</h3>
        {owner ? (
          <SegmentedControl
            aria-label="Visibility"
            options={VIS}
            value={staged}
            onChange={(v) => !patch.isPending && setPending(v)}
          />
        ) : (
          <VisibilityBadge visibility={artifact.visibility} />
        )}
        {owner && changed && (
          <div className="oa-invite">
            <Button
              variant="primary"
              loading={patch.isPending}
              onClick={() =>
                staged === "public"
                  ? setConfirmPublic(true)
                  : commitVisibility(staged)
              }
            >
              Save visibility
            </Button>
            <Button
              variant="ghost"
              disabled={patch.isPending}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
          </div>
        )}
        <p className="oa-muted">{NOTE[staged]}</p>
      </section>

      {owner && (
        <section>
          <h3>Invite</h3>
          <form
            className="oa-invite"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              invite();
            }}
          >
            <Input
              type="email"
              aria-label="Email"
              placeholder="name@example.com"
              value={email}
              aria-invalid={invalid}
              onChange={(e) => {
                setEmail(e.target.value);
                setInvalid(false);
              }}
            />
            <Select
              aria-label="Invite role"
              options={ROLES}
              value={role}
              onChange={setRole}
            />
            <Button type="submit" loading={put.isPending}>
              Invite
            </Button>
          </form>
          {invalid && <p role="alert">Enter a valid email address.</p>}
        </section>
      )}

      <section>
        <h3>People</h3>
        <ul className="oa-people">
          <li>
            <Avatar name={artifact.owner.name} email={artifact.owner.email} />
            <span>{displayName(artifact.owner)}</span>
            <span className="oa-muted">Owner</span>
          </li>
          {(shares.data ?? []).map((s) => (
            <li key={s.email}>
              <Avatar name={null} email={s.email} />
              <span>{s.email}</span>
              {owner ? (
                <>
                  <Select
                    aria-label={`Role for ${s.email}`}
                    options={ROLES}
                    value={s.role}
                    onChange={(r) =>
                      put.mutate(
                        { email: s.email, role: r },
                        { onError: (x) => fail(x, "Couldn't change role") },
                      )
                    }
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${s.email}`}
                    onClick={() =>
                      del.mutate(s.email, {
                        onError: (x) => fail(x, "Couldn't remove"),
                      })
                    }
                  >
                    ×
                  </Button>
                </>
              ) : (
                <span className="oa-muted">{s.role}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Live data</h3>
        {CAPS.map(([k, label]) => (
          <Checkbox
            key={k}
            label={label}
            checked={artifact.capabilities[k]}
            disabled={!owner || patch.isPending}
            onCheckedChange={(on) => setCap(k, on === true)}
          />
        ))}
        <Checkbox
          label="Allow anonymous writes"
          checked={artifact.allowAnonymousWrites}
          disabled={
            !owner ||
            patch.isPending ||
            artifact.visibility !== "public" ||
            !artifact.capabilities.db
          }
          onCheckedChange={(on) => save({ allowAnonymousWrites: on === true })}
        />
      </section>

      <Button onClick={copy}>Copy link</Button>

      <Dialog
        open={confirmPublic}
        onOpenChange={setConfirmPublic}
        title="Make this public?"
        description="Anyone with the link can view. It won't appear in search engines."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmPublic(false);
                setPending(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmPublic(false);
                commitVisibility("public");
              }}
            >
              Make public
            </Button>
          </>
        }
      />
    </div>
  );
}
