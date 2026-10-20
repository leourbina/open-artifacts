import { type ArtifactSummary, diffPath, viewerPath } from "@oa/shared";
import { Avatar, Button, Dialog, displayName } from "@oa/ui";
import { Separator, Button as ShButton, Skeleton } from "@oa/ui/shadcn";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import { useRestoreVersion, useVersionPages } from "../../api/queries";
import { useSingleFlight } from "../../api/useSingleFlight";
import { toast } from "../../layout/toast";
import { AppLink } from "../../library/AppLink";
import { relativeTime } from "../../library/time";
import { LINK_BTN, SM } from "../ui";

export function Versions({ artifact }: { artifact: ArtifactSummary }) {
  const { id, currentVersion } = artifact;
  const q = useVersionPages(id);
  const restore = useRestoreVersion(id);
  const once = useSingleFlight();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const [target, setTarget] = useState<number | null>(null);
  const canRestore = artifact.access !== "viewer";
  const items = q.data?.pages.flat() ?? [];

  if (q.isPending)
    return (
      <div aria-busy="true" className="mt-3 grid gap-3">
        <span className="sr-only">Loading versions…</span>
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-7 w-24" />
      </div>
    );
  if (q.error && !items.length)
    return <p role="alert">Couldn't load versions.</p>;

  return (
    <div className="oa-versions">
      <ol className="my-3 flex list-none flex-col gap-3 p-0">
        {items.map((x, i) => (
          <li key={x.version} className="flex flex-col gap-2">
            {i > 0 && <Separator className="mb-1" />}
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex gap-1">
                <strong>v{x.version}</strong>
                {x.version === currentVersion && <span>· Current</span>}
              </span>
              <span className="ml-auto text-muted-foreground">
                {relativeTime(x.createdAt)}
              </span>
            </div>
            <div>{x.message || "No message"}</div>
            <div className="flex flex-wrap items-center gap-2">
              <Avatar name={x.createdBy.name} email={x.createdBy.email} />
              <span>{x.agent?.name ?? displayName(x.createdBy)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ShButton
                asChild
                variant="outline"
                size="xs"
                className={LINK_BTN}
              >
                <AppLink href={viewerPath(id, x.version)}>View</AppLink>
              </ShButton>
              {x.version !== currentVersion && (
                <ShButton
                  asChild
                  variant="outline"
                  size="xs"
                  className={LINK_BTN}
                >
                  <AppLink href={diffPath(id, x.version, currentVersion)}>
                    Compare with current
                  </AppLink>
                </ShButton>
              )}
              {canRestore && x.version !== currentVersion && (
                <ShButton
                  variant="outline"
                  size="xs"
                  className={SM}
                  onClick={() => setTarget(x.version)}
                >
                  Restore
                </ShButton>
              )}
            </div>
          </li>
        ))}
      </ol>
      {q.hasNextPage && (
        <ShButton
          variant="outline"
          size="xs"
          className={SM}
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          Load older versions
        </ShButton>
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
                once((done) =>
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
                    onSettled: done,
                  }),
                )
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
