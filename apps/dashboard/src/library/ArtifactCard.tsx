import type { ArtifactSummary } from "@oa/shared";
import { Avatar, FormatIcon, VisibilityBadge } from "@oa/ui";
import { AppLink } from "./AppLink";
import { relativeTime } from "./time";

export type CardProps = { artifact: ArtifactSummary; meId?: string };

function Meta({ artifact: a, meId }: CardProps) {
  return (
    <div className="lib-meta">
      <FormatIcon format={a.format} size={14} />
      <VisibilityBadge visibility={a.visibility} />
      {a.lastAgent && <span>{a.lastAgent.name}</span>}
      {a.owner.id !== meId && (
        <Avatar
          name={a.owner.name ?? undefined}
          email={a.owner.email ?? a.owner.name ?? "Unknown"}
        />
      )}
      <time dateTime={a.updatedAt}>{relativeTime(a.updatedAt)}</time>
    </div>
  );
}

export function ArtifactCard(p: CardProps) {
  const a = p.artifact;
  return (
    <article className="lib-card">
      <div className="lib-thumb">
        {a.thumbnailUrl ? (
          <img src={a.thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <div className="lib-fallback">
            <FormatIcon format={a.format} size={20} decorative />
            <span>{a.title}</span>
          </div>
        )}
      </div>
      <h3>
        <AppLink href={`/a/${a.id}`}>{a.title}</AppLink>
      </h3>
      <Meta {...p} />
    </article>
  );
}
