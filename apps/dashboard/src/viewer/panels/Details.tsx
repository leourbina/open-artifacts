import type { ArtifactSummary } from "@oa/shared";
import { Button, Dialog, displayName, Input, Textarea, toast } from "@oa/ui";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import {
  useDeleteArtifact,
  usePatchArtifact,
  useVersionInfo,
} from "../../api/queries";
import { offerUndo } from "../undoToast";

const fmtSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;
const fail = (e: unknown, fallback: string) =>
  toast({
    title: e instanceof ApiClientError ? e.message : fallback,
    tone: "danger",
  });

export function Details({ artifact }: { artifact: ArtifactSummary }) {
  const { id } = artifact;
  const canEdit = artifact.access !== "viewer";
  const owner = artifact.access === "owner";
  const info = useVersionInfo(id, artifact.currentVersion).data;
  const patch = usePatchArtifact(id);
  const del = useDeleteArtifact(id);
  const navigate = useNavigate();
  const [title, setTitle] = useState(artifact.title);
  const [desc, setDesc] = useState(artifact.description ?? "");
  const [confirm, setConfirm] = useState(false);
  const t = title.trim();
  const valid = t.length >= 1 && t.length <= 200 && desc.length <= 2000;
  const dirty = t !== artifact.title || desc !== (artifact.description ?? "");

  const save = () =>
    patch.mutate(
      { title: t, description: desc },
      {
        onError: (e) => {
          setTitle(artifact.title);
          setDesc(artifact.description ?? "");
          fail(e, "Couldn't save");
        },
      },
    );
  const remove = () =>
    del.mutate(undefined, {
      onSuccess: () => {
        setConfirm(false);
        void navigate({ to: "/" });
        offerUndo(id, artifact.title);
      },
      onError: (e) => {
        setConfirm(false);
        fail(e, "Couldn't delete");
      },
    });

  return (
    <div className="oa-details">
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && dirty) save();
          }}
        >
          <div>
            <span id="oa-d-title">Title</span>
            <Input
              aria-labelledby="oa-d-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <span id="oa-d-desc">Description</span>
            <Textarea
              aria-labelledby="oa-d-desc"
              value={desc}
              maxLength={2000}
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            loading={patch.isPending}
            disabled={!valid || !dirty}
          >
            Save
          </Button>
        </form>
      )}
      <dl className="oa-dl">
        <dt>Format</dt>
        <dd>{artifact.format}</dd>
        <dt>Entry</dt>
        <dd>{info?.entry ?? "…"}</dd>
        <dt>Files</dt>
        <dd>
          <ul>
            {(info?.files ?? []).map((f) => (
              <li key={f.path}>
                {f.path} <span className="oa-muted">{fmtSize(f.size)}</span>
              </li>
            ))}
          </ul>
        </dd>
        <dt>Created</dt>
        <dd>{new Date(artifact.createdAt).toLocaleString()}</dd>
        <dt>Owner</dt>
        <dd>{displayName(artifact.owner)}</dd>
      </dl>
      {owner && (
        <>
          <Button variant="danger" onClick={() => setConfirm(true)}>
            Delete artifact
          </Button>
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
                  onClick={remove}
                >
                  Delete
                </Button>
              </>
            }
          />
        </>
      )}
    </div>
  );
}
