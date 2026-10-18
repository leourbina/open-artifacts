import type { ArtifactSummary } from "@oa/shared";
import { Avatar, FormatIcon, VisibilityBadge } from "@oa/ui";
import { useState } from "react";
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

/** The typographic fallback, with the thumbnail fading in over it once decoded. */
function Thumb({ artifact: a }: CardProps) {
  // The URL whose image has decoded; a new URL starts hidden again.
  const [ready, setReady] = useState<string | null>(null);
  const url = a.thumbnailUrl;
  const shown = url !== null && ready === url;
  return (
    <div className="lib-thumb">
      <div className="lib-fallback" aria-hidden={shown || undefined}>
        <FormatIcon format={a.format} size={20} decorative />
        <span>{a.title}</span>
      </div>
      {url && (
        <img
          key={url}
          src={url}
          alt=""
          loading="lazy"
          data-ready={shown || undefined}
          onLoad={(e) =>
            e.currentTarget.decode().then(
              () => setReady(url),
              () => {},
            )
          }
        />
      )}
    </div>
  );
}

export function ArtifactCard(p: CardProps) {
  return (
    <article className="lib-card">
      <Thumb {...p} />
      <h3>
        <AppLink className="lib-title" href={`/a/${p.artifact.id}`}>
          {p.artifact.title}
        </AppLink>
      </h3>
      <Meta {...p} />
    </article>
  );
}
