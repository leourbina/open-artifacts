import { type ArtifactSummary, viewerPath } from "@oa/shared";
import { Button, Dialog, Input, Select, Textarea, toast } from "@oa/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { qk } from "../api/queries";
import "./upload.css";
import {
  defaultEntry,
  type Progress,
  relativePaths,
  UploadValidationError,
  uploadArtifact,
} from "./uploadPipeline";

const stem = (p: string) => (p.split("/").pop() ?? p).replace(/\.[^.]*$/, "");

export function UploadDialog({
  files,
  artifact,
  onClose,
}: {
  files: File[];
  artifact?: ArtifactSummary;
  onClose: () => void;
}) {
  const paths = relativePaths(files);
  const auto = defaultEntry(paths);
  const [title, setTitle] = useState(stem(auto ?? paths[0] ?? ""));
  const [message, setMessage] = useState("");
  const [entry, setEntry] = useState<string | undefined>(auto);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const busy = progress !== null;
  const needsEntry = auto === undefined;
  const invalid = (!artifact && !title.trim()) || (needsEntry && !entry);

  const cancel = () => {
    abort.current?.abort();
    onClose();
  };

  const submit = async () => {
    setError(null);
    abort.current = new AbortController();
    try {
      const r = await uploadArtifact(
        { files, title, artifactId: artifact?.id, message, entry },
        setProgress,
        abort.current.signal,
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["artifacts"] }),
        qc.invalidateQueries({ queryKey: ["search"] }),
        qc.invalidateQueries({ queryKey: qk.artifact(r.id) }),
      ]);
      toast({
        title: artifact ? `Published v${r.version}` : "Artifact created",
      });
      onClose();
      void navigate({ to: viewerPath(r.id, r.version) as never });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setProgress(null);
      setError(
        e instanceof UploadValidationError || e instanceof ApiClientError
          ? e.message
          : "Upload failed. Try again.",
      );
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && cancel()}
      title={
        artifact ? `Upload new version of ${artifact.title}` : "Create artifact"
      }
      description={`${files.length} file${files.length === 1 ? "" : "s"} selected`}
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || invalid}
            onClick={() => void submit()}
          >
            {busy ? "Uploading…" : artifact ? "Publish version" : "Create"}
          </Button>
        </>
      }
    >
      <form
        className="up-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !invalid) void submit();
        }}
      >
        {!artifact && (
          <div>
            <label htmlFor="up-title">Title</label>
            <Input
              id="up-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
              disabled={busy}
            />
          </div>
        )}
        {needsEntry && (
          <div>
            <span id="up-entry">Entry file</span>
            <Select
              aria-labelledby="up-entry"
              options={paths.map((p) => ({ value: p, label: p }))}
              value={entry}
              onChange={setEntry}
              placeholder="Choose the file to open first"
              disabled={busy}
            />
          </div>
        )}
        <div>
          <label htmlFor="up-message">Message (optional)</label>
          <Textarea
            id="up-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={500}
            rows={2}
            disabled={busy}
          />
        </div>
        {progress && (
          <p role="status" className="up-progress">
            Uploaded {progress.done} of {progress.total}
          </p>
        )}
        {error && (
          <p role="alert" className="up-error">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
