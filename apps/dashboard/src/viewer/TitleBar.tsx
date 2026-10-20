import {
  type ArtifactSummary,
  AUTH,
  R,
  type UserRef,
  viewerPath,
} from "@oa/shared";
import { Button, Dialog, FormatIcon } from "@oa/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Button as ShButton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import {
  qk,
  useDeleteArtifact,
  usePatchArtifact,
  useVersionInfo,
  useVersions,
} from "../api/queries";
import { toast } from "../layout/toast";
import { fullPath } from "./paths";
import { ICON, LINK_BTN, SM, TXT, VisibilityBadge } from "./ui";
import { useOfferUndo } from "./useOfferUndo";

const TITLE_MAX = 200;
/** The page h1: Design's 20/600. */
const H1 =
  "m-0 min-w-0 truncate text-[length:var(--oa-text-xl)] leading-tight font-semibold";
const who = (u: UserRef) => u.name ?? u.email ?? "Unknown";

function EditableTitle({ artifact }: { artifact: ArtifactSummary }) {
  const patch = usePatchArtifact(artifact.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const done = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  // Enter/Escape return focus to the title; a blur elsewhere keeps it there.
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [editing]);

  const finish = (save: boolean, keyboard = false) => {
    if (done.current) return;
    done.current = true;
    refocus.current = keyboard;
    setEditing(false);
    const title = draft.trim().slice(0, TITLE_MAX);
    if (!save || !title || title === artifact.title) return;
    patch.mutate(
      { title },
      {
        onError: (e) =>
          toast({
            title: e instanceof ApiClientError ? e.message : "Couldn't rename",
            tone: "danger",
          }),
      },
    );
  };

  if (!editing)
    return (
      <h1 className={H1}>
        <button
          ref={button}
          type="button"
          className="m-0 max-w-full cursor-text truncate border-0 bg-transparent p-0 [font:inherit] text-inherit underline-offset-[3px] hover:underline hover:decoration-dotted focus-visible:rounded-sm focus-visible:underline focus-visible:decoration-dotted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
          title="Rename"
          onClick={() => {
            done.current = false;
            setDraft(artifact.title);
            setEditing(true);
          }}
        >
          {artifact.title}
        </button>
      </h1>
    );
  return (
    <h1 className={H1}>
      <Input
        className="oa-vt-input h-8 w-[min(480px,60vw)] text-[length:var(--oa-text-lg)]"
        aria-label="Title"
        value={draft}
        maxLength={TITLE_MAX}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(true, true);
          else if (e.key === "Escape") finish(false, true);
        }}
      />
    </h1>
  );
}

/** Full screen's icon: lucide Maximize2 at 14px, 4px from the label. */
const MAXIMIZE = <Maximize2 className="size-3.5" aria-hidden="true" />;

export function TitleBar({
  artifact,
  version,
  explicitVersion,
  authed,
  onShare,
  panelOpen,
  onPanel,
}: {
  artifact: ArtifactSummary;
  version: number;
  explicitVersion: boolean;
  authed: boolean;
  onShare: () => void;
  panelOpen: boolean;
  onPanel: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const versions = useVersions(artifact.id, { enabled: authed });
  const del = useDeleteArtifact(artifact.id);
  const offerUndo = useOfferUndo();
  const [confirm, setConfirm] = useState(false);
  const isOwner = authed && artifact.access === "owner";
  const canEdit = authed && artifact.access !== "viewer";
  const go = (to: string) => void navigate({ to: to as string });

  const info = useVersionInfo(artifact.id, version, authed).data;
  const entry = info?.entry;
  const iconFormat =
    info?.format ??
    (version === artifact.currentVersion ? artifact.format : undefined);
  const deleting = useRef(false);
  const deleted = useRef(false);
  // Dropped only once the viewer has unmounted, so nothing refetches the 404.
  useEffect(
    () => () => {
      if (deleted.current)
        qc.removeQueries({ queryKey: qk.artifact(artifact.id) });
    },
    [qc, artifact.id],
  );
  const next = viewerPath(artifact.id, explicitVersion ? version : undefined);
  const full = fullPath(artifact.id);
  const openFull = () => window.open(full, "_blank", "noopener");
  const label = `v${version}${version === artifact.currentVersion ? " · Current" : ""}`;
  const items: (
    | "separator"
    | { label: string; danger?: boolean; onSelect: () => void }
  )[] = [
    {
      label: "Copy link",
      onSelect: () =>
        void navigator.clipboard
          ?.writeText(location.origin + viewerPath(artifact.id))
          .then(
            () => toast({ title: "Link copied", tone: "success" }),
            () => {},
          ),
    },
    {
      label: "Copy full-screen link",
      onSelect: () =>
        void navigator.clipboard?.writeText(location.origin + full).then(
          () => toast({ title: "Full-screen link copied", tone: "success" }),
          () => {},
        ),
    },
    ...(authed && entry
      ? [
          {
            label: "Download entry",
            onSelect: () => {
              const a = document.createElement("a");
              a.href = R.versionFile(artifact.id, version, entry);
              a.download = entry.split("/").pop() ?? entry;
              a.click();
            },
          },
        ]
      : []),
    ...(isOwner
      ? [
          "separator" as const,
          { label: "Delete", danger: true, onSelect: () => setConfirm(true) },
        ]
      : []),
  ];

  return (
    <div className="oa-vt flex flex-wrap items-center gap-[10px] border-0 border-b border-solid border-border bg-card px-5 py-[10px] max-[600px]:px-4">
      <div className="flex min-w-0 items-center gap-2 max-[600px]:flex-[1_1_100%]">
        {iconFormat && <FormatIcon format={iconFormat} />}
        {canEdit ? (
          <EditableTitle artifact={artifact} />
        ) : (
          <h1 className={H1}>{artifact.title}</h1>
        )}
        <VisibilityBadge visibility={artifact.visibility} />
      </div>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 max-[600px]:flex-[1_1_100%]">
        {authed && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ShButton
                variant="outline"
                size="xs"
                className={SM}
                aria-label={`Version: ${label}`}
              >
                {label}
              </ShButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={TXT}>
              {(versions.data ?? []).map((x) => (
                <DropdownMenuItem
                  key={x.version}
                  onSelect={() => go(viewerPath(artifact.id, x.version))}
                >
                  {`v${x.version}${x.version === artifact.currentVersion ? " (current)" : ""} · ${x.agent?.name ?? who(x.createdBy)}`}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* On phones it moves into the ••• menu, which only signed-in
            viewers have. */}
        <ShButton
          asChild
          variant="outline"
          size="xs"
          className={`${LINK_BTN} ${authed ? "max-[600px]:hidden" : ""}`}
        >
          <a href={full} target="_blank" rel="noopener noreferrer">
            {MAXIMIZE}
            Full screen
          </a>
        </ShButton>
        {authed && (
          <ShButton
            variant="outline"
            size="xs"
            className={`${SM} max-[600px]:hidden`}
            aria-expanded={panelOpen}
            onClick={onPanel}
          >
            Versions
          </ShButton>
        )}
        {isOwner && (
          <ShButton size="xs" className={SM} onClick={onShare}>
            Share
          </ShButton>
        )}
        {authed ? (
          <TooltipProvider>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <ShButton
                      variant="outline"
                      size="xs"
                      className={SM}
                      aria-label="More actions"
                    >
                      •••
                    </ShButton>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>More actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className={TXT}>
                <DropdownMenuItem
                  className="gap-1 min-[601px]:hidden"
                  onSelect={openFull}
                >
                  {MAXIMIZE}
                  Full screen
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-[601px]:hidden"
                  onSelect={onPanel}
                >
                  Versions
                </DropdownMenuItem>
                <DropdownMenuSeparator className="min-[601px]:hidden" />
                {items.map((it) =>
                  it === "separator" ? (
                    <DropdownMenuSeparator key="separator" />
                  ) : (
                    <DropdownMenuItem
                      key={it.label}
                      variant={it.danger ? "destructive" : "default"}
                      onSelect={it.onSelect}
                    >
                      {it.label}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipProvider>
        ) : (
          <ShButton
            asChild
            size="xs"
            className={`${SM} text-primary-foreground no-underline hover:text-primary-foreground`}
          >
            <a href={`${AUTH.login}?next=${encodeURIComponent(next)}`}>
              Sign in
            </a>
          </ShButton>
        )}
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete artifact?"
        description={`"${artifact.title}" will be recoverable for 30 days.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() => {
                if (deleting.current) return;
                deleting.current = true;
                del.mutate(undefined, {
                  onSuccess: () => {
                    deleted.current = true;
                    go("/");
                    offerUndo(artifact.id, artifact.title);
                  },
                  onError: () => {
                    deleting.current = false;
                    toast({ title: "Couldn't delete", tone: "danger" });
                  },
                });
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}
