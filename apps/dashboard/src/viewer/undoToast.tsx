import { ArtifactSummarySchema, R, viewerPath } from "@oa/shared";
import { Button, toast } from "@oa/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { qk } from "../api/queries";

type Undo = { id: number; title: string; artifactId: string };
let current: Undo | null = null;
let next = 0;
const listeners = new Set<(u: Undo | null) => void>();
const set = (u: Undo | null) => {
  current = u;
  for (const l of listeners) l(u);
};

/** Offers Undo for a just-deleted artifact. @oa/ui toasts carry no action, so this has its own. */
export const offerUndo = (artifactId: string, title: string) => {
  const id = next++;
  set({ id, title, artifactId });
  setTimeout(() => current?.id === id && set(null), 10_000);
};

/** Mounted next to the app's Toaster. */
export function UndoToast() {
  const [u, setU] = useState(current);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    listeners.add(setU);
    return () => {
      listeners.delete(setU);
    };
  }, []);
  if (!u) return null;
  const undo = async () => {
    setBusy(true);
    try {
      await api.send(
        "POST",
        R.restoreDeleted(u.artifactId),
        undefined,
        ArtifactSummarySchema,
      );
      set(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["artifacts"] }),
        qc.invalidateQueries({ queryKey: qk.artifact(u.artifactId) }),
      ]);
      void navigate({ to: viewerPath(u.artifactId) as string });
    } catch {
      toast({ title: "Couldn't undo the delete", tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="oa-undo" role="status">
      <span>Deleted “{u.title}”</span>
      <Button size="sm" loading={busy} onClick={() => void undo()}>
        Undo
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Dismiss"
        onClick={() => set(null)}
      >
        ×
      </Button>
    </div>
  );
}
