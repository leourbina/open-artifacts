import { type Member, MemberInviteSchema, type Role } from "@oa/shared";
import { Avatar, Button, Dialog, displayName, Input, Select } from "@oa/ui";
import { useState } from "react";
import { ApiClientError } from "../api/client";
import {
  useInviteMember,
  useMembers,
  usePatchMember,
  useRemoveMember,
} from "../api/queries";
import { useMe } from "../auth/useMe";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { relativeTime } from "../library/time";

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

function InviteDialog({ onClose }: { onClose: () => void }) {
  const invite = useInviteMember();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Assignable>("member");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (invite.isPending) return;
    const parsed = parseInviteEmail(email);
    if (!parsed) return setError("Enter a valid email address (ASCII only).");
    setError(null);
    invite.mutate(
      { email: parsed, role },
      {
        onSuccess: onClose,
        onError: (e) =>
          setError(e instanceof ApiClientError ? e.message : "Invite failed."),
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Invite a member"
      description="They sign in with a one-time code sent to their email."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={invite.isPending}
            onClick={submit}
          >
            Send invite
          </Button>
        </>
      }
    >
      <form
        id="oa-invite-form"
        className="oa-form"
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
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Select
          aria-label="Role"
          options={ROLES}
          value={role}
          onChange={setRole}
        />
        {error && (
          <p role="alert" className="oa-err">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function Row({ m, you }: { m: Member; you: boolean }) {
  const patch = usePatchMember();
  const [confirm, setConfirm] = useState(false);
  const remove = useRemoveMember();
  const label = displayName(m);
  const locked = m.role === "owner" || you;
  return (
    <li className="oa-member">
      <div className="oa-who">
        <Avatar name={m.name} email={m.email} />
        <div>
          <b>
            <span>{label}</span>
            {you && <span className="oa-seen"> (you)</span>}
          </b>
          {m.name && <small>{m.email}</small>}
        </div>
      </div>
      {m.role === "owner" ? (
        <span>Owner</span>
      ) : you ? (
        <span>{ROLE_LABEL[m.role]}</span>
      ) : (
        <Select
          aria-label={`Role for ${label}`}
          options={ROLES}
          value={m.role === "admin" || m.role === "member" ? m.role : undefined}
          placeholder="Guest"
          onChange={(role) => patch.mutate({ id: m.id, role })}
        />
      )}
      <span className="oa-seen">
        {m.lastSeenAt ? relativeTime(m.lastSeenAt) || "Unknown" : "Never"}
      </span>
      {locked ? (
        <span />
      ) : (
        <Button
          variant="ghost"
          aria-label={`Remove ${label}`}
          onClick={() => setConfirm(true)}
        >
          Remove
        </Button>
      )}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${label}?`}
        description="Their artifacts will be transferred to you (owner)."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
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
  return (
    <section className="oa-card" aria-labelledby="oa-members-h">
      <div className="oa-card-head">
        <h2 id="oa-members-h">Members</h2>
        <Button variant="primary" onClick={() => setInviting(true)}>
          Invite
        </Button>
      </div>
      {q.isError ? (
        <p role="alert" className="oa-err" style={{ padding: "0 18px 16px" }}>
          Couldn't load members.
        </p>
      ) : (
        <ul className="oa-members">
          {q.data?.map((m) => (
            <Row key={m.id} m={m} you={m.id === me?.id} />
          ))}
        </ul>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </section>
  );
}
