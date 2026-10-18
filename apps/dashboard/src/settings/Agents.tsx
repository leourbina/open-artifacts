import {
  R,
  type TokenCreated,
  TokenCreatedSchema,
  TokenCreateInputSchema,
} from "@oa/shared";
import { Button, Dialog, Input, SegmentedControl, Tabs, toast } from "@oa/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiClientError, api } from "../api/client";
import {
  qk,
  useOAuthClients,
  useRevokeOAuthClient,
  useRevokeToken,
  useTokens,
} from "../api/queries";
import { useMe } from "../auth/useMe";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { relativeTime } from "../library/time";
import { snippets } from "./snippets";

const copyText = (text: string, ok: string) => {
  const failed = () =>
    toast({
      title: "Couldn't copy",
      description: "Copy it by hand.",
      tone: "danger",
    });
  if (!navigator.clipboard) return failed();
  navigator.clipboard
    .writeText(text)
    .then(() => toast({ title: ok, tone: "success" }), failed);
};

const when = (iso: string) => relativeTime(iso) || "Unknown";

function Code({ code, label }: { code: string; label: string }) {
  return (
    <div className="oa-code">
      <pre>
        <code>{code}</code>
      </pre>
      <Button
        variant="ghost"
        aria-label={label}
        onClick={() => copyText(code, "Copied")}
      >
        Copy
      </Button>
    </div>
  );
}

/** Agent picker over one variant's snippets. */
function SnippetTabs({
  mcpUrl,
  token,
  variant,
}: {
  mcpUrl: string;
  token?: string;
  variant: "oauth" | "token";
}) {
  const list = snippets(mcpUrl, token).filter((s) => s.variant === variant);
  return (
    <Tabs
      tabs={list.map((s) => ({
        id: s.agent,
        label: s.agent,
        content: (
          <>
            {s.file && <p className="oa-seen">{s.file}</p>}
            <Code
              code={s.code}
              label={s.language === "bash" ? "Copy command" : "Copy config"}
            />
          </>
        ),
      }))}
    />
  );
}

function Connect({ mcpUrl }: { mcpUrl: string }) {
  const [variant, setVariant] = useState<"oauth" | "token">("oauth");
  return (
    <>
      <SegmentedControl
        aria-label="Auth method"
        options={[
          { value: "oauth", label: "OAuth" },
          { value: "token", label: "Token" },
        ]}
        value={variant}
        onChange={setVariant}
      />
      <SnippetTabs mcpUrl={mcpUrl} variant={variant} />
    </>
  );
}

function Confirm({
  title,
  action,
  onClose,
  onConfirm,
}: {
  title: string;
  action: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description="Anything using it stops working immediately."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {action}
          </Button>
        </>
      }
    />
  );
}

function OAuthClients() {
  const q = useOAuthClients();
  const revoke = useRevokeOAuthClient();
  const [target, setTarget] = useState<{
    grantId: string;
    clientName: string;
  } | null>(null);
  return (
    <section className="oa-card" aria-labelledby="oa-oauth-h">
      <div className="oa-card-head">
        <h2 id="oa-oauth-h">Connected agents</h2>
      </div>
      {q.isError ? (
        <p role="alert" className="oa-err">
          Couldn't load connected agents.
        </p>
      ) : q.data?.length === 0 ? (
        <p className="oa-seen">
          No agents connected yet. They appear here after you approve them.
        </p>
      ) : (
        <ul className="oa-members">
          {q.data?.map((c) => (
            <li key={c.grantId} className="oa-row">
              <b>{c.clientName}</b>
              <span className="oa-seen">Connected {when(c.createdAt)}</span>
              <Button
                variant="ghost"
                aria-label={`Revoke ${c.clientName}`}
                disabled={revoke.isPending && revoke.variables === c.grantId}
                onClick={() => setTarget(c)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {target && (
        <Confirm
          title={`Revoke ${target.clientName}?`}
          action="Revoke"
          onClose={() => setTarget(null)}
          onConfirm={() => revoke.mutate(target.grantId)}
        />
      )}
    </section>
  );
}

/** The token lives only in this component's state; closing clears it. */
function CreateDialog({ onClose }: { onClose: () => void }) {
  const state = useMe();
  const mcpUrl = state.status === "authed" ? state.me.instance.mcpUrl : null;
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const submit = async () => {
    if (busy) return;
    const parsed = TokenCreateInputSchema.safeParse({ label });
    if (!parsed.success) return setError("Enter a label (1–80 characters).");
    setError(null);
    setBusy(true);
    try {
      // Not a react-query mutation: its result would sit in the mutation cache.
      setCreated(
        await api.send("POST", R.tokens, parsed.data, TokenCreatedSchema),
      );
      void qc.invalidateQueries({ queryKey: qk.tokens });
    } catch (e) {
      setError(
        e instanceof ApiClientError ? e.message : "Couldn't create the token.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      // Mid-request or with the token on screen, only Done closes it.
      onOpenChange={(o) => !o && !busy && !created && onClose()}
      title={created ? "Token created" : "Create token"}
      description={
        created
          ? undefined
          : "Tokens act as you. Give it a label so you can recognize it."
      }
      footer={
        created ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              Create
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="oa-form">
          <p role="alert">You won't see this again.</p>
          <Code code={created.token} label="Copy token" />
          {mcpUrl && (
            <SnippetTabs
              mcpUrl={mcpUrl}
              token={created.token}
              variant="token"
            />
          )}
        </div>
      ) : (
        <form
          className="oa-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            aria-label="Label"
            autoComplete="off"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          {error && (
            <p role="alert" className="oa-err">
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}

function Tokens() {
  const q = useTokens();
  const revoke = useRevokeToken();
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<{ id: string; label: string } | null>(
    null,
  );
  return (
    <section className="oa-card" aria-labelledby="oa-pat-h">
      <div className="oa-card-head">
        <h2 id="oa-pat-h">Personal access tokens</h2>
        <Button variant="secondary" onClick={() => setCreating(true)}>
          Create token
        </Button>
      </div>
      {q.isError ? (
        <p role="alert" className="oa-err">
          Couldn't load tokens.
        </p>
      ) : q.data?.length === 0 ? (
        <p className="oa-seen">
          No tokens. Create one for a script or an agent that can't use OAuth.
        </p>
      ) : (
        <ul className="oa-members">
          {q.data?.map((t) => (
            <li key={t.id} className="oa-row">
              <b>{t.label}</b>
              <span className="oa-seen">Created {when(t.createdAt)}</span>
              <span className="oa-seen">
                Last used {t.lastUsedAt ? when(t.lastUsedAt) : "Never"}
              </span>
              <Button
                variant="ghost"
                aria-label={`Revoke ${t.label}`}
                disabled={revoke.isPending && revoke.variables === t.id}
                onClick={() => setTarget(t)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {target && (
        <Confirm
          title={`Revoke ${target.label}?`}
          action="Revoke"
          onClose={() => setTarget(null)}
          onConfirm={() => revoke.mutate(target.id)}
        />
      )}
    </section>
  );
}

export function Agents() {
  useDocumentTitle("Agents");
  const state = useMe();
  const mcpUrl = state.status === "authed" ? state.me.instance.mcpUrl : null;
  return (
    <div className="oa-stack">
      {mcpUrl && (
        <section className="oa-card" aria-labelledby="oa-mcp-h">
          <div className="oa-card-head">
            <h2 id="oa-mcp-h">MCP server</h2>
          </div>
          <div className="oa-form">
            <Input readOnly aria-label="MCP server URL" value={mcpUrl} />
            <Button
              variant="secondary"
              onClick={() => copyText(mcpUrl, "MCP URL copied")}
            >
              Copy URL
            </Button>
          </div>
          <Connect mcpUrl={mcpUrl} />
        </section>
      )}
      <OAuthClients />
      <Tokens />
    </div>
  );
}
