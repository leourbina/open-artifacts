import { type Member, MemberInviteSchema, type Role } from "@oa/shared";
import { Avatar, displayName } from "@oa/ui";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@oa/ui/shadcn";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import {
  useInviteMember,
  useMembers,
  usePatchMember,
  useRemoveMember,
} from "../api/queries";
import { emailEnabled } from "../auth/emailEnabled";
import { useMe } from "../auth/useMe";
import { CopyLink } from "../layout/CopyLink";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { relativeTime } from "../library/time";
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

/** Header, body and footer of a settings dialog. */
function Modal({
  open = true,
  onClose,
  title,
  description,
  footer,
  children,
}: {
  open?: boolean;
  onClose: () => void;
  title: string;
  description: string;
  footer: ReactNode;
  children?: ReactNode;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="gap-[var(--oa-space-4)] sm:max-w-[440px]"
        // No Radix Trigger (the dialog is controlled), so put focus back on
        // whatever opened it, as a trigger would.
        onOpenAutoFocus={() => {
          opener.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-[length:var(--oa-text-lg)]">
            {title}
          </DialogTitle>
          <DialogDescription className="text-[length:var(--oa-text-sm)]">
            {description}
          </DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  const submit = () => {
    if (invite.isPending) return;
    const parsed = parseInviteEmail(email);
    if (!parsed) return setError("Enter a valid email address (ASCII only).");
    setError(null);
    invite.mutate(
      { email: parsed, role },
      {
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
  "grid min-h-[52px] grid-cols-[minmax(0,1fr)_112px_136px_72px] items-center gap-[10px] border-0 border-t border-solid border-border py-[var(--oa-space-2)] max-[600px]:grid-cols-[minmax(0,1fr)_112px]";

function Row({ m, you }: { m: Member; you: boolean }) {
  const patch = usePatchMember();
  const [confirm, setConfirm] = useState(false);
  const remove = useRemoveMember();
  const label = displayName(m);
  const locked = m.role === "owner" || you;
  return (
    <li className={ROW}>
      <div className="flex min-w-0 items-center gap-[10px]">
        <Avatar name={m.name} email={m.email} />
        <div className="min-w-0">
          <b className="block truncate font-medium">
            <span>{label}</span>
            {you && <span className="text-muted-foreground"> (you)</span>}
          </b>
          {m.name && (
            <small className={`block truncate ${muted}`}>{m.email}</small>
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
      <span className={muted}>{lastSeen(m.lastSeenAt)}</span>
      {locked ? (
        <span />
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
        <ul className="m-0 grid list-none p-0">
          {q.data?.map((m) => (
            <Row key={m.id} m={m} you={m.id === me?.id} />
          ))}
        </ul>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </SettingsCard>
  );
}
