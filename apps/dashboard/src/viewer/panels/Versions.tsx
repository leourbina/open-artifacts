import { type ArtifactSummary, diffPath, viewerPath } from "@oa/shared";
import { Avatar, Button, Dialog, displayName, toast } from "@oa/ui";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import { useRestoreVersion, useVersionPages } from "../../api/queries";
import { AppLink } from "../../library/AppLink";
import { relativeTime } from "../../library/time";

export function Versions({ artifact }: { artifact: ArtifactSummary }) {
  const { id, currentVersion } = artifact;
  const q = useVersionPages(id);
  const restore = useRestoreVersion(id);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const [target, setTarget] = useState<number | null>(null);
  const canRestore = artifact.access !== "viewer";
  const items = q.data?.pages.flat() ?? [];

  if (q.isPending) return <p aria-busy="true">Loading versions…</p>;
  if (q.error && !items.length)
    return <p role="alert">Couldn't load versions.</p>;

  return (
    <div className="oa-versions">
      <ol className="oa-vlist">
        {items.map((x) => (
          <li key={x.version} className="oa-vrow">
            <div className="oa-vrow-head">
              <strong>v{x.version}</strong>
              {x.version === currentVersion && <span> · Current</span>}
              <span className="oa-muted">{relativeTime(x.createdAt)}</span>
            </div>
            <div className="oa-vmsg">{x.message || "No message"}</div>
            <div className="oa-vmeta">
              <Avatar name={x.createdBy.name} email={x.createdBy.email} />
              <span>{x.agent?.name ?? displayName(x.createdBy)}</span>
            </div>
            <div className="oa-vacts">
              <AppLink className="oa-btn" href={viewerPath(id, x.version)}>
                View
              </AppLink>
              {x.version !== currentVersion && (
                <AppLink
                  className="oa-btn"
                  href={diffPath(id, x.version, currentVersion)}
                >
                  Compare with current
                </AppLink>
              )}
              {canRestore && x.version !== currentVersion && (
                <Button size="sm" onClick={() => setTarget(x.version)}>
                  Restore
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {q.hasNextPage && (
        <Button
          loading={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          Load older versions
        </Button>
      )}
      <Dialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title={`Restore v${target ?? ""}?`}
        description="This publishes a new version with the contents of the selected one."
        footer={
          <>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={restore.isPending}
              onClick={() =>
                target !== null &&
                restore.mutate(target, {
                  onSuccess: (r) => {
                    setTarget(null);
                    void navigate({
                      to: viewerPath(id, r.version) as string,
                      search: search as never,
                    });
                  },
                  onError: (e) =>
                    toast({
                      title:
                        e instanceof ApiClientError
                          ? e.message
                          : "Couldn't restore",
                      tone: "danger",
                    }),
                })
              }
            >
              Restore version
            </Button>
          </>
        }
      />
    </div>
  );
}
