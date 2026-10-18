import type { ArtifactSummary } from "@oa/shared";
import { Button } from "@oa/ui";
import { useEffect, useRef, useState } from "react";
import { filesFromDrop, filterIgnored } from "./collect";
import { UploadDialog } from "./UploadDialog";
import "./upload.css";

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");

const UploadIcon = () => (
  <svg
    viewBox="0 0 16 16"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 11V2.5M4.5 6 8 2.5 11.5 6M2.5 10v3.5h11V10" />
  </svg>
);

/**
 * Window-level drop target plus a picker button. Without `artifact`, uploads create a new
 * artifact; with one, they add a version (editors and above only). Takes `allowed` rather
 * than calling useMe: a second observer on a failed /me query would refetch it.
 */
export function DropZone({
  artifact,
  allowed,
  button = false,
}: {
  artifact?: ArtifactSummary;
  /** Whether this user may publish here (signed in, not a guest). */
  allowed: boolean;
  button?: boolean;
}) {
  const enabled = allowed && (!artifact || artifact.access !== "viewer");
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<File[] | null>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!enabled) return;
    let depth = 0; // dragenter/leave fire per child element, so count them
    const reset = () => {
      depth = 0;
      setDragging(false);
    };
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) reset();
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      reset();
      void filesFromDrop(e.dataTransfer).then((f) => f.length && setFiles(f));
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && reset();
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      window.removeEventListener("keydown", key);
      reset();
    };
  }, [enabled]);

  if (!enabled) return null;
  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = filterIgnored([...(e.target.files ?? [])]);
    e.target.value = "";
    if (f.length) setFiles(f);
  };
  return (
    <>
      {button && (
        <span className="up-buttons">
          <Button onClick={() => filePicker.current?.click()}>
            Upload files
          </Button>
          <Button variant="ghost" onClick={() => folderPicker.current?.click()}>
            Upload folder
          </Button>
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            data-testid="upload-files"
            onChange={picked}
          />
          <input
            ref={folderPicker}
            type="file"
            hidden
            data-testid="upload-folder"
            // @ts-expect-error non-standard attribute, supported by all current browsers
            webkitdirectory=""
            onChange={picked}
          />
        </span>
      )}
      {dragging && (
        <div className="up-drop" role="presentation">
          <div className="up-zone">
            <div className="up-icon">
              <UploadIcon />
            </div>
            <h2>
              {artifact
                ? "Drop files to add a new version"
                : "Drop files to create an artifact"}
            </h2>
            <p>
              {artifact
                ? "The dropped files become the next version of this artifact."
                : "One file makes one artifact; several files dropped together make one multi-file artifact. To add a version instead, drop onto an open artifact."}
            </p>
            <div className="up-foot">
              Up to 25 MB per file and 100 MB per drop
              {artifact ? "" : " · Visibility starts as Private"}
            </div>
          </div>
        </div>
      )}
      {files && (
        <UploadDialog
          files={files}
          artifact={artifact}
          onClose={() => setFiles(null)}
        />
      )}
    </>
  );
}
