import { type Member, MemberInviteSchema, type Role } from "@oa/shared";
import { Avatar, displayName } from "@oa/ui";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@oa/ui/shadcn";
import { useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { hasFeature } from "../api/contract";
import {
  useInviteMember,
  useMembers,
  usePatchMember,
  useRemoveMember,
  useSetRestricted,
} from "../api/queries";
import { emailEnabled } from "../auth/emailEnabled";
import { useMe } from "../auth/useMe";
import { CopyLink } from "../layout/CopyLink";
import { Modal } from "../layout/Modal";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { relativeTime } from "../library/time";
import { ConfirmDialog } from "./ConfirmDialog";
import { restrictionReason } from "./restriction";
import { errorText, muted, SettingsCard } from "./ui";

type Assignable = "admin" | "member";
/** Owner is never offered, to anyone. */
const ROLES: { value: Assignable; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

/** Trimmed, lowercased, ASCII-only email, or null. */
export const parseInviteEmail = (raw: string) => {
  const v = raw.trim().toLowerCase();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII check
  if (!/^[\x00-\x7f]+$/.test(v)) return null;
  const r = MemberInviteSchema.shape.email.safeParse(v);
  return r.success ? r.data : null;
};

function RoleSelect({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: Assignable | undefined;
  placeholder?: string;
  onChange: (role: Assignable) => void;
}) {
  return (
    <Select
      value={value ?? ""}
      onValueChange={(v) => onChange(v as Assignable)}
    >
      <SelectTrigger
        aria-label={label}
        size="sm"
        className="w-full text-[length:var(--oa-text-sm)]"
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper">
        {ROLES.map((r) => (
          <SelectItem
            key={r.value}
            value={r.value}
            className="text-[length:var(--oa-text-sm)]"
          >
            {r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const sends = emailEnabled(me);
  const invite = useInviteMember();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Assignable>("member");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{
    email: string;
    emailed: boolean;
  } | null>(null);
  // Set synchronously: `isPending` only turns true on the next render, so two
  // submits in one tick (a fast double Enter) would both pass that check.
  const sending = useRef(false);
  const submit = () => {
    if (sending.current || invite.isPending) return;
    const parsed = parseInviteEmail(email);
    if (!parsed) return setError("Enter a valid email address (ASCII only).");
    setError(null);
    sending.current = true;
    invite.mutate(
      { email: parsed, role },
      {
        onSettled: () => {
          sending.current = false;
        },
        onSuccess: (r) => setAdded({ email: parsed, emailed: r.emailed }),
        onError: (e) =>
          setError(e instanceof ApiClientError ? e.message : "Couldn't add."),
      },
    );
  };
  if (added) {
    // location.origin is the app host, where sign-in starts.
    const url = location.origin;
    return (
      <Modal
        onClose={onClose}
        title={
          added.emailed
            ? `Invitation sent to ${added.email}`
            : `${added.email} can now sign in`
        }
        description={
          added.emailed
            ? `They can also sign in at ${url} with a one-time code.`
            : `Send them this link. They'll sign in at ${url} with a one-time code sent to that address.`
        }
        footer={<Button onClick={onClose}>Done</Button>}
      >
        {sends && !added.emailed && (
          <p role="status" className={errorText}>
            The email didn't send. Copy the link and share it yourself.
          </p>
        )}
        <CopyLink link={url} label="Sign-in link" />
      </Modal>
    );
  }
  return (
    <Modal
      onClose={onClose}
      title="Add a member"
      description={
        sends
          ? `We'll email them a link to ${me?.instance.name}. They'll sign in with a one-time code.`
          : "Open Artifacts doesn't send invitations. Add their email here, then send them the sign-in link yourself."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={invite.isPending} onClick={submit}>
            Add member
          </Button>
        </>
      }
    >
      <form
        id="oa-invite-form"
        className="grid gap-[var(--oa-space-3)]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          type="text"
          inputMode="email"
          autoComplete="off"
          aria-label="Email"
          placeholder="name@example.com"
          className="text-[length:var(--oa-text-sm)]"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <RoleSelect label="Role" value={role} onChange={setRole} />
        {error && (
          <p role="alert" className={errorText}>
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

const lastSeen = (iso: string | null) => {
  if (!iso) return "Never signed in";
  const when = relativeTime(iso);
  return when ? `Active ${when}` : "Last active unknown";
};

/** Who, role, last seen, action; at <= 600px, who and role, then the rest. */
const ROW =
  "grid min-h-[52px] grid-cols-[minmax(0,1fr)_112px_136px_72px] items-center gap-[10px] border-0 border-t border-border py-[var(--oa-space-2)] max-[600px]:grid-cols-[minmax(0,1fr)_112px]";

/** The Restricted badge: warning-soft, unlike the neutral role badges. */
const RESTRICTED_BADGE =
  "border-transparent bg-[var(--oa-warning-soft)] text-[var(--oa-warning)]";

/** "Bob" from "Bob Builder", else the email's local part. */
const firstName = (m: Member) =>
  m.name?.trim().split(/\s+/)[0] || m.email.split("@")[0];

function Row({ m, you, hosted }: { m: Member; you: boolean; hosted: boolean }) {
  const patch = usePatchMember();
  const [confirm, setConfirm] = useState(false);
  const [restricting, setRestricting] = useState(false);
  const [lifting, setLifting] = useState(false);
  const remove = useRemoveMember();
  const setRestricted = useSetRestricted();
  const label = displayName(m);
  const locked = m.role === "owner" || you;
  const why = hosted ? restrictionReason(m.restriction) : null;
  const manual = m.restriction?.manual === true;
  const groups = m.restriction?.groups ?? [];
  // The manual flag only: active members, never owners, admins or guests.
  const canRestrict =
    hosted && m.role === "member" && (m.status ?? "active") === "active";
  const first = firstName(m);
  return (
    <li className={ROW}>
      <div className="flex min-w-0 items-center gap-[10px]">
        <Avatar name={m.name} email={m.email} />
        <div className="min-w-0">
          <b className="flex min-w-0 items-center gap-[6px] font-medium">
            <span className="truncate">{label}</span>
            {you && <span className="text-muted-foreground"> (you)</span>}
            {why && (
              <Badge
                variant="outline"
                data-tone="warning"
                className={`flex-none max-[600px]:hidden ${RESTRICTED_BADGE}`}
              >
                Restricted
              </Badge>
            )}
          </b>
          {(m.name || why) && (
            <small className={`block truncate ${muted}`}>
              {m.name ? m.email : null}
              {/* At <= 600px the badge and reason move to the control line. */}
              <span className="max-[600px]:hidden">
                {m.name && why ? " · " : null}
                {why}
              </span>
            </small>
          )}
        </div>
      </div>
      {m.role === "owner" || you ? (
        <Badge variant="outline" className="justify-self-start">
          {ROLE_LABEL[m.role]}
        </Badge>
      ) : (
        <RoleSelect
          label={`Role for ${label}`}
          value={m.role === "admin" || m.role === "member" ? m.role : undefined}
          placeholder="Guest"
          onChange={(role) => patch.mutate({ id: m.id, role })}
        />
      )}
      {/* Labelled inline: there is no column header at any width. */}
      <span className={muted}>
        {why && (
          <span className="mb-[4px] hidden items-center gap-[6px] max-[600px]:flex">
            <Badge
              variant="outline"
              data-tone="warning"
              className={RESTRICTED_BADGE}
            >
              Restricted
            </Badge>{" "}
            {why}
          </span>
        )}
        {lastSeen(m.lastSeenAt)}
      </span>
      {locked ? (
        <span />
      ) : hosted ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-end"
              aria-label={`More for ${label}`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="currentColor"
              >
                <circle cx="3" cy="8" r="1.5" />
                <circle cx="8" cy="8" r="1.5" />
                <circle cx="13" cy="8" r="1.5" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="text-[length:var(--oa-text-sm)]"
          >
            {canRestrict && (
              <DropdownMenuItem
                onSelect={() =>
                  manual ? setLifting(true) : setRestricting(true)
                }
              >
                {manual ? "Lift manual restriction…" : "Restrict by hand…"}
              </DropdownMenuItem>
            )}
            {groups.length > 0 && (
              // The group cause is cleared on Directory, never here.
              <DropdownMenuItem disabled className="flex-col items-start gap-0">
                <span>
                  Restricted {restrictionReason({ manual: false, groups })}
                </span>
                <small className={muted}>
                  Lift it in Directory, Restricted groups
                </small>
              </DropdownMenuItem>
            )}
            {(canRestrict || groups.length > 0) && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => setConfirm(true)}>
              Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-end text-[length:var(--oa-text-sm)]"
          aria-label={`Remove ${label}`}
          onClick={() => setConfirm(true)}
        >
          Remove
        </Button>
      )}
      <ConfirmDialog
        open={restricting}
        onClose={() => setRestricting(false)}
        title={`Restrict ${label}?`}
        body={
          <p>
            {first} will only be able to view, in every space and in their
            personal space. They can't publish, edit, share or write live data,
            from the app or any AI agent. Their artifacts stay where they are.
          </p>
        }
        confirm="Restrict"
        onConfirm={() =>
          setRestricted.mutate({ memberId: m.id, restricted: true })
        }
      />
      <ConfirmDialog
        open={lifting}
        onClose={() => setLifting(false)}
        title={`Lift ${first}'s manual restriction?`}
        body={
          <p>
            {groups.length
              ? `${first} stays restricted ${restrictionReason({ manual: false, groups })}. To lift that, remove ${groups.map((g) => g.name ?? g.email).join(", ")} from Restricted groups in Directory.`
              : `${first} gets back the roles their spaces and groups give them.`}
          </p>
        }
        confirm="Lift manual restriction"
        onConfirm={() =>
          setRestricted.mutate({ memberId: m.id, restricted: false })
        }
      />
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Remove ${label}?`}
        description="Their artifacts will be transferred to you (owner)."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirm(false);
                remove.mutate(m.id);
              }}
            >
              Remove member
            </Button>
          </>
        }
      />
    </li>
  );
}

export function Members() {
  useDocumentTitle("Members");
  const state = useMe();
  const q = useMembers();
  const [inviting, setInviting] = useState(false);
  const me = state.status === "authed" ? state.me.user : null;
  // Hosted (the spaces feature): restriction badges and the row's More menu.
  const hosted = state.status === "authed" && hasFeature(state.me, "spaces");
  return (
    <SettingsCard
      id="oa-members-h"
      title="Members"
      action={
        <Button
          size="sm"
          className="text-[length:var(--oa-text-sm)]"
          onClick={() => setInviting(true)}
        >
          Add member
        </Button>
      }
    >
      {q.isError ? (
        <p role="alert" className={errorText}>
          Couldn't load members.
        </p>
      ) : (
        <ul className="grid p-0">
          {q.data?.map((m) => (
            <Row key={m.id} m={m} you={m.id === me?.id} hosted={hosted} />
          ))}
        </ul>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </SettingsCard>
  );
}
