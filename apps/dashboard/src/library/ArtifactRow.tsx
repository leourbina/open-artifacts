import type { ArtifactSummary } from "@oa/shared";
import { FormatIcon } from "@oa/ui";
import { AppLink } from "./AppLink";
import { Snippet } from "./Snippet";
import { relativeTime } from "./time";

export function ArtifactRow({
  artifact: a,
  snippet,
}: {
  artifact: ArtifactSummary;
  snippet?: string;
}) {
  return (
    <article className="lib-row">
      <FormatIcon format={a.format} />
      <div className="lib-row-main">
        <AppLink className="lib-title" href={`/a/${a.id}`}>
          {a.title}
        </AppLink>
        {snippet && (
          <p className="lib-snippet">
            <Snippet text={snippet} />
          </p>
        )}
      </div>
      <span className="muted">{a.lastAgent?.name}</span>
      <time dateTime={a.updatedAt} className="muted">
        {relativeTime(a.updatedAt)}
      </time>
    </article>
  );
}
