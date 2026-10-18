import {
  type ArtifactSummary,
  AUTH,
  R,
  type UserRef,
  viewerPath,
} from "@oa/shared";
import {
  Button,
  Dialog,
  FormatIcon,
  Menu,
  toast,
  VisibilityBadge,
} from "@oa/ui";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import {
  useDeleteArtifact,
  usePatchArtifact,
  useVersionInfo,
  useVersions,
} from "../api/queries";
import "./viewer.css";

const TITLE_MAX = 200;
const who = (u: UserRef) => u.name ?? u.email ?? "Unknown";

function EditableTitle({ artifact }: { artifact: ArtifactSummary }) {
  const patch = usePatchArtifact(artifact.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const done = useRef(false);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
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
      <h1 className="oa-vt-title">
        <button
          type="button"
          className="oa-vt-edit"
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
    <h1 className="oa-vt-title">
      <input
        className="oa-vt-input"
        aria-label="Title"
        value={draft}
        maxLength={TITLE_MAX}
        // biome-ignore lint/a11y/noAutofocus: the user just chose to rename
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(true);
          else if (e.key === "Escape") finish(false);
        }}
      />
    </h1>
  );
}

export function TitleBar({
  artifact,
  version,
  explicitVersion,
  rawUrl,
  authed,
  onShare,
  panelOpen,
  onPanel,
}: {
  artifact: ArtifactSummary;
  version: number;
  explicitVersion: boolean;
  rawUrl: string | null;
  authed: boolean;
  onShare: () => void;
  panelOpen: boolean;
  onPanel: () => void;
}) {
  const navigate = useNavigate();
  const versions = useVersions(artifact.id, { enabled: authed });
  const del = useDeleteArtifact(artifact.id);
  const [confirm, setConfirm] = useState(false);
  const isOwner = authed && artifact.access === "owner";
  const canEdit = authed && artifact.access !== "viewer";
  const go = (to: string) => void navigate({ to: to as string });

  const entry = useVersionInfo(artifact.id, version, authed).data?.entry;
  const deleting = useRef(false);
  const next = viewerPath(artifact.id, explicitVersion ? version : undefined);
  const label = `v${version}${version === artifact.currentVersion ? " · Current" : ""}`;
  const items = [
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
    <div className="oa-vt">
      <div className="oa-vt-group">
        <FormatIcon format={artifact.format} />
        {canEdit ? (
          <EditableTitle artifact={artifact} />
        ) : (
          <h1 className="oa-vt-title">{artifact.title}</h1>
        )}
        <VisibilityBadge visibility={artifact.visibility} />
      </div>
      <div className="oa-vt-actions">
        {authed && (
          <Menu
            trigger={
              <Button size="sm" aria-label={`Version: ${label}`}>
                {label}
              </Button>
            }
            items={(versions.data ?? []).map((x) => ({
              label: `v${x.version}${x.version === artifact.currentVersion ? " (current)" : ""} · ${x.agent?.name ?? who(x.createdBy)}`,
              onSelect: () => go(viewerPath(artifact.id, x.version)),
            }))}
          />
        )}
        {rawUrl && (
          <a
            className="oa-btn"
            href={rawUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open raw
          </a>
        )}
        {authed && (
          <Button size="sm" aria-expanded={panelOpen} onClick={onPanel}>
            Versions
          </Button>
        )}
        {isOwner && (
          <Button size="sm" variant="primary" onClick={onShare}>
            Share
          </Button>
        )}
        {authed ? (
          <Menu
            trigger={
              <Button size="sm" aria-label="More actions">
                •••
              </Button>
            }
            items={items}
          />
        ) : (
          <a
            className="oa-btn oa-primary"
            href={`${AUTH.login}?next=${encodeURIComponent(next)}`}
          >
            Sign in
          </a>
        )}
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete artifact?"
        description={`"${artifact.title}" will be recoverable for 30 days.`}
        footer={
          <Button
            variant="danger"
            loading={del.isPending}
            onClick={() => {
              if (deleting.current) return;
              deleting.current = true;
              del.mutate(undefined, {
                onSuccess: () => go("/"),
                onError: () => {
                  deleting.current = false;
                  toast({ title: "Couldn't delete", tone: "danger" });
                },
              });
            }}
          >
            Delete
          </Button>
        }
      />
    </div>
  );
}
