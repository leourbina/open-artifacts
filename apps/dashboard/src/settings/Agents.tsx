import {
  R,
  type TokenCreated,
  TokenCreatedSchema,
  TokenCreateInputSchema,
} from "@oa/shared";
import { Button, Dialog, Input, toast } from "@oa/ui";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button as ShButton,
  Input as ShInput,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToggleGroup,
  ToggleGroupItem,
} from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
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

/** Code with its Copy button beside it (never over it); no outer padding, so
    it fits a card or a dialog. */
function CodeBlock({
  children,
  copy,
  label,
}: {
  children: ReactNode;
  copy: string;
  label: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-[var(--oa-space-1)] rounded-md bg-secondary">
      {children}
      <ShButton
        variant="ghost"
        size="sm"
        className="m-[var(--oa-space-1)] flex-none text-[length:var(--oa-text-sm)]"
        aria-label={label}
        onClick={() => copyText(copy, "Copied")}
      >
        Copy
      </ShButton>
    </div>
  );
}

function Code({ code, label }: { code: string; label: string }) {
  return (
    <CodeBlock copy={code} label={label}>
      <pre
        // Focusable so keyboard users can scroll a long line.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
        tabIndex={0}
        className="m-0 min-w-0 flex-1 overflow-x-auto p-[var(--oa-space-3)] font-mono text-[length:var(--oa-text-xs)]"
      >
        <code>{code}</code>
      </pre>
    </CodeBlock>
  );
}

/** Agent picker over one variant's snippets. The pick survives a variant
    switch when that agent has a snippet there too. */
function SnippetTabs({
  mcpUrl,
  variant,
}: {
  mcpUrl: string;
  variant: "oauth" | "token";
}) {
  const list = snippets(mcpUrl).filter((s) => s.variant === variant);
  const [picked, setPicked] = useState(list[0]?.agent);
  // Values are indexes: Radix builds element ids from them, and agent names
  // have spaces.
  const current = Math.max(
    list.findIndex((s) => s.agent === picked),
    0,
  );
  const listRef = useRef<HTMLDivElement>(null);
  return (
    <Tabs
      value={String(current)}
      onValueChange={(v) => {
        setPicked(list[Number(v)]?.agent);
        // The strip scrolls sideways on phones; keep the picked tab in view
        // (clicks and arrow keys alike).
        listRef.current?.children[Number(v)]?.scrollIntoView?.({
          block: "nearest",
          inline: "nearest",
        });
      }}
      className={`min-w-0 ${GAP}`}
    >
      {/* The strip scrolls, so it clips anything outside it: the hairline is
          an inset shadow, the underline sits at the bottom edge, and the
          focus ring is inset. */}
      <TabsList
        ref={listRef}
        variant="line"
        className="h-[34px] w-full justify-start gap-[var(--oa-space-4)] overflow-x-auto rounded-none p-0 shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none]"
      >
        {list.map((s, i) => (
          <TabsTrigger
            key={s.agent}
            value={String(i)}
            className="h-full flex-none px-0 text-[length:var(--oa-text-sm)] group-data-[orientation=horizontal]/tabs:after:bottom-0 group-data-[orientation=horizontal]/tabs:after:h-[2px] focus-visible:outline-offset-[-2px]"
          >
            {s.agent}
          </TabsTrigger>
        ))}
      </TabsList>
      {list.map((s, i) => (
        <TabsContent
          key={s.agent}
          value={String(i)}
          className="grid min-w-0 gap-[var(--oa-space-2)] data-[state=inactive]:hidden"
        >
          {s.hint && <p className={muted}>{s.hint}</p>}
          {s.file && <p className={muted}>{s.file}</p>}
          <Code
            code={s.code}
            label={s.language === "bash" ? "Copy command" : "Copy config"}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function Connect({ mcpUrl }: { mcpUrl: string }) {
  const [variant, setVariant] = useState<"oauth" | "token">("oauth");
  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-label="Auth method"
        value={variant}
        // Single toggle groups can deselect; keep one method chosen.
        onValueChange={(v) => v && setVariant(v as "oauth" | "token")}
      >
        <ToggleGroupItem
          value="oauth"
          className="h-[30px] px-[var(--oa-space-3)] text-[length:var(--oa-text-sm)]"
        >
          OAuth
        </ToggleGroupItem>
        <ToggleGroupItem
          value="token"
          className="h-[30px] px-[var(--oa-space-3)] text-[length:var(--oa-text-sm)]"
        >
          Token
        </ToggleGroupItem>
      </ToggleGroup>
      <SnippetTabs mcpUrl={mcpUrl} variant={variant} />
    </>
  );
}

/** Settings card: one inset for every child (Design: 20px, 16px <= 600px). */
const CARD =
  "gap-[var(--oa-space-3)] py-[var(--oa-space-5)] shadow-none max-[600px]:py-[var(--oa-space-4)]";
const INSET = "px-[var(--oa-space-5)] max-[600px]:px-[var(--oa-space-4)]";
/** One vertical rhythm inside a card. */
const GAP = "gap-[var(--oa-space-3)]";

function SettingsCard({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <Card className={CARD}>
        <CardHeader
          className={`flex min-h-[30px] items-center justify-between ${GAP} ${INSET}`}
        >
          <CardTitle>
            <h2
              id={id}
              className="m-0 text-[length:var(--oa-text-md)] font-semibold"
            >
              {title}
            </h2>
          </CardTitle>
          {action}
        </CardHeader>
        <CardContent className={`grid min-w-0 ${GAP} ${INSET}`}>
          {children}
        </CardContent>
      </Card>
    </section>
  );
}

const muted = "m-0 text-[length:var(--oa-text-xs)] text-muted-foreground";

/** Name, meta and actions on one line; at <= 600px the name takes its own
    ellipsized line and the meta and actions share the next. */
const ROWS =
  "m-0 grid list-none gap-[var(--oa-space-1)] p-0 max-[600px]:gap-[var(--oa-space-3)]";
const ROW =
  "flex min-h-[34px] items-center gap-[var(--oa-space-3)] max-[600px]:min-h-0 max-[600px]:flex-wrap max-[600px]:gap-y-[var(--oa-space-2)]";
const NAME =
  "min-w-0 flex-1 font-medium [overflow-wrap:anywhere] max-[600px]:basis-full max-[600px]:truncate";
const ACTION = "flex-none text-[length:var(--oa-text-sm)] max-[600px]:ml-auto";

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
    <SettingsCard id="oa-oauth-h" title="Connected agents">
      {q.isError ? (
        <p role="alert" className="oa-err">
          Couldn't load connected agents.
        </p>
      ) : q.data?.length === 0 ? (
        <p className={muted}>
          No agents connected yet. They appear here after you approve them.
        </p>
      ) : (
        <ul className={ROWS}>
          {q.data?.map((c) => (
            <li key={c.grantId} className={ROW}>
              <b className={NAME}>{c.clientName}</b>
              <span className={muted}>Connected {when(c.createdAt)}</span>
              <ShButton
                className={ACTION}
                variant="ghost"
                size="sm"
                aria-label={`Revoke ${c.clientName}`}
                disabled={revoke.isPending && revoke.variables === c.grantId}
                onClick={() => setTarget(c)}
              >
                Revoke
              </ShButton>
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
    </SettingsCard>
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
          <CodeBlock copy={created.token} label="Copy token">
            <code className="oa-token block min-w-0 flex-1 p-[var(--oa-space-3)] font-mono text-[length:var(--oa-text-xs)] break-all">
              {created.token}
            </code>
          </CodeBlock>
          {mcpUrl && (
            <>
              <p className="oa-seen">
                Snippets read the token from OA_TOKEN. In your shell, run{" "}
                <code>read -rs OA_TOKEN; export OA_TOKEN</code> and paste it.
              </p>
              <SnippetTabs mcpUrl={mcpUrl} variant="token" />
            </>
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
    <SettingsCard
      id="oa-pat-h"
      title="Personal access tokens"
      action={
        <ShButton
          variant="outline"
          size="sm"
          className="text-[length:var(--oa-text-sm)]"
          onClick={() => setCreating(true)}
        >
          Create token
        </ShButton>
      }
    >
      {q.isError ? (
        <p role="alert" className="oa-err">
          Couldn't load tokens.
        </p>
      ) : q.data?.length === 0 ? (
        <p className={muted}>
          No tokens. Create one for a script or an agent that can't use OAuth.
        </p>
      ) : (
        <ul className={ROWS}>
          {q.data?.map((t) => (
            <li key={t.id} className={ROW}>
              <b className={NAME}>{t.label}</b>
              <span className={muted}>Created {when(t.createdAt)}</span>
              <span className={muted}>
                Last used {t.lastUsedAt ? when(t.lastUsedAt) : "Never"}
              </span>
              <ShButton
                className={ACTION}
                variant="ghost"
                size="sm"
                aria-label={`Revoke ${t.label}`}
                disabled={revoke.isPending && revoke.variables === t.id}
                onClick={() => setTarget(t)}
              >
                Revoke
              </ShButton>
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
    </SettingsCard>
  );
}

export function Agents() {
  useDocumentTitle("Agents");
  const state = useMe();
  const mcpUrl = state.status === "authed" ? state.me.instance.mcpUrl : null;
  return (
    <div className="oa-stack">
      {mcpUrl && (
        <SettingsCard id="oa-mcp-h" title="MCP server">
          <div className="flex min-w-0 items-center gap-[var(--oa-space-2)]">
            <ShInput
              readOnly
              aria-label="MCP server URL"
              value={mcpUrl}
              className="h-[30px] flex-1 text-[length:var(--oa-text-sm)] md:text-[length:var(--oa-text-sm)]"
            />
            <ShButton
              variant="outline"
              className="h-[30px] flex-none text-[length:var(--oa-text-sm)]"
              onClick={() => copyText(mcpUrl, "MCP URL copied")}
            >
              Copy URL
            </ShButton>
          </div>
          <Connect mcpUrl={mcpUrl} />
        </SettingsCard>
      )}
      <OAuthClients />
      <Tokens />
    </div>
  );
}
