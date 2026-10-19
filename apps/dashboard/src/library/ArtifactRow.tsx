import type { ArtifactSummary } from "@oa/shared";
import { FormatIcon } from "@oa/ui";
import { AppLink } from "./AppLink";
import { Snippet } from "./Snippet";
import { relativeTime } from "./time";
import { META, STRETCH, TITLE_LINK } from "./ui";

const ROW = `lib-row ${STRETCH} flex items-center gap-[var(--oa-space-3)] rounded-md bg-card px-[var(--oa-space-3)] py-[var(--oa-space-2)] text-card-foreground shadow-[var(--oa-shadow-1)] transition-colors duration-(--oa-duration-fast) ease-(--oa-ease) hover:bg-[var(--oa-surface-2)] has-[a:focus-visible]:outline-offset-[-2px] active:bg-[var(--oa-sunken)]`;

export function ArtifactRow({
  artifact: a,
  snippet,
}: {
  artifact: ArtifactSummary;
  snippet?: string;
}) {
  return (
    <article className={ROW}>
      <FormatIcon format={a.format} />
      <div className="min-w-0 flex-1">
        <AppLink className={TITLE_LINK} href={`/a/${a.id}`}>
          {a.title}
        </AppLink>
        {snippet && (
          <p className="mt-[var(--oa-space-1)] mb-0 text-muted-foreground">
            <Snippet text={snippet} />
          </p>
        )}
      </div>
      <span className={META}>{a.lastAgent?.name}</span>
      <time dateTime={a.updatedAt} className={META}>
        {relativeTime(a.updatedAt)}
      </time>
    </article>
  );
}
