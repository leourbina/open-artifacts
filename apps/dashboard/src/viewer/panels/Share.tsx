import {
  type ArtifactPatch,
  type ArtifactSummary,
  type ShareRole,
  ShareSchema,
  type Visibility,
  viewerPath,
} from "@oa/shared";
import { Avatar, Banner, Checkbox, displayName, VisibilityBadge } from "@oa/ui";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@oa/ui/shadcn";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import {
  useDeleteShare,
  usePatchArtifact,
  usePutShare,
  useShares,
} from "../../api/queries";
import { emailEnabled } from "../../auth/emailEnabled";
import { useMe } from "../../auth/useMe";
import { CopyLink } from "../../layout/CopyLink";
import { Modal } from "../../layout/Modal";
import { toast } from "../../layout/toast";

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
  ["db", "Database", "Lets the page store shared data."],
  ["viewer", "Viewer identity", "Lets the page see who is viewing."],
  ["storage", "File storage", "Lets the page keep uploaded files."],
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

const TEXT = "text-[length:var(--oa-text-sm)]";
const CONTROL = `h-[30px] ${TEXT}`;
const H3 = "m-0 mb-[6px] text-[length:var(--oa-text-sm)] font-semibold";
const MUTED = "m-0 text-muted-foreground";
const PERSON = "flex items-center gap-[var(--oa-space-2)]";
const NAME = "min-w-0 flex-1 truncate";

function RoleSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ShareRole;
  onChange: (r: ShareRole) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ShareRole)}>
      <SelectTrigger
        aria-label={label}
        size="sm"
        className={`w-[96px] flex-none ${TEXT}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {ROLES.map((r) => (
          <SelectItem key={r.value} value={r.value} className={TEXT}>
            {r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

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
  const [shared, setShared] = useState<{
    email: string;
    emailed: boolean;
  } | null>(null);
  const state = useMe();
  const sends = emailEnabled(state.status === "authed" ? state.me : null);

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
        onSuccess: (r) => {
          setEmail("");
          setShared({ email: e, emailed: r.emailed });
        },
        onError: (x) => fail(x, "Couldn't share"),
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
    <div className="oa-share flex flex-col gap-[var(--oa-space-4)]">
      {/* #189/#193: toggle, helper text 8px below, then the action row 16px
          after it. The accent marks the chosen visibility. */}
      <section>
        <h3 id="oa-share-vis" className={H3}>
          Visibility
        </h3>
        {owner ? (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Visibility"
            value={staged}
            onValueChange={(v) =>
              v && !patch.isPending && setPending(v as Visibility)
            }
          >
            {VIS.map((o) => (
              <ToggleGroupItem
                key={o.value}
                value={o.value}
                className={`px-[var(--oa-space-3)] ${CONTROL}`}
                // Radio semantics: arrowing to an option chooses it, as the
                // radiogroup role promises (Radix only moves focus).
                // TODO: drop once Design's ToggleGroup primitive selects on arrow.
                onFocus={() => !patch.isPending && setPending(o.value)}
              >
                {o.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : (
          <VisibilityBadge visibility={artifact.visibility} />
        )}
        <p className={`oa-vis-note mt-[var(--oa-space-2)] ${MUTED}`}>
          {NOTE[staged]}
        </p>
        {owner && changed && (
          <div className="mt-[var(--oa-space-4)] flex items-center gap-[var(--oa-space-2)]">
            <Button
              size="sm"
              className={CONTROL}
              disabled={patch.isPending}
              aria-busy={patch.isPending || undefined}
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
              size="sm"
              className={CONTROL}
              disabled={patch.isPending}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
          </div>
        )}
      </section>

      {owner && (
        <section>
          <h3 className={H3}>Add people</h3>
          <form
            className="flex flex-wrap items-center gap-[var(--oa-space-2)]"
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
              className={`basis-full ${CONTROL} md:${TEXT}`}
              onChange={(e) => {
                setEmail(e.target.value);
                setInvalid(false);
              }}
            />
            <RoleSelect label="Invite role" value={role} onChange={setRole} />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className={CONTROL}
              disabled={put.isPending}
              aria-busy={put.isPending || undefined}
            >
              Add
            </Button>
          </form>
          {invalid && (
            <p
              role="alert"
              className="mt-[var(--oa-space-2)] mb-0 text-destructive"
            >
              Enter a valid email address.
            </p>
          )}
          <p className={`mt-[var(--oa-space-3)] ${MUTED}`}>
            {sends
              ? "We'll email them a link. You can also copy it and send it yourself."
              : "No email is sent. Copy the link and share it yourself."}
          </p>
        </section>
      )}

      <section>
        {shared && (
          <div className="mb-[var(--oa-space-4)] [&_p]:mt-0 [&_p]:mb-[var(--oa-space-2)]">
            <Banner
              tone="success"
              title={`Shared with ${shared.email}`}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Dismiss"
                  onClick={() => setShared(null)}
                >
                  {"\u00d7"}
                </Button>
              }
            >
              <p>
                {shared.emailed
                  ? "We emailed them a link. They'll sign in with a one-time code."
                  : artifact.visibility === "public"
                    ? "Send them this link. They can open it without signing in."
                    : "Send them this link. They'll sign in with a one-time code sent to that address, then see the artifact."}
              </p>
              {/* emailed:false with email on is not a failure here: members and
                  re-shares are never emailed, so there's no "didn't send" line. */}
              <CopyLink link={link} label="Artifact link" />
            </Banner>
          </div>
        )}
        <h3 className={H3}>People</h3>
        <ul className="m-0 flex list-none flex-col gap-[var(--oa-space-2)] p-0">
          <li className={PERSON}>
            <Avatar name={artifact.owner.name} email={artifact.owner.email} />
            <span className={NAME} title={displayName(artifact.owner)}>
              {displayName(artifact.owner)}
            </span>
            <span className="text-muted-foreground">Owner</span>
          </li>
          {(shares.data ?? []).map((s) => (
            <li key={s.email} className={PERSON}>
              <Avatar name={null} email={s.email} />
              <span className={NAME} title={s.email}>
                {s.email}
              </span>
              {owner ? (
                <>
                  <RoleSelect
                    label={`Role for ${s.email}`}
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
                    className="size-[30px] flex-none p-0"
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
                <span className="text-muted-foreground">{s.role}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className={H3}>Live data</h3>
        {CAPS.map(([k, label, hint]) => (
          <div className="oa-cap" key={k}>
            <Checkbox
              label={label}
              checked={artifact.capabilities[k]}
              disabled={!owner || patch.isPending}
              onCheckedChange={(on) => setCap(k, on === true)}
            />
            <small className="oa-muted">{hint}</small>
          </div>
        ))}
        <div className="oa-cap">
          <Checkbox
            label="Allow anonymous writes"
            checked={artifact.allowAnonymousWrites}
            disabled={
              !owner ||
              patch.isPending ||
              artifact.visibility !== "public" ||
              !artifact.capabilities.db
            }
            onCheckedChange={(on) =>
              save({ allowAnonymousWrites: on === true })
            }
          />
          <small className="oa-muted">Public and database only.</small>
        </div>
      </section>

      <Button
        variant="outline"
        size="sm"
        className={`w-full ${CONTROL}`}
        onClick={copy}
      >
        Copy link
      </Button>

      <Modal
        open={confirmPublic}
        onClose={() => setConfirmPublic(false)}
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
