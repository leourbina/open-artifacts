import type { Format } from "@oa/shared";
import {
  Button,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@oa/ui/shadcn";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useRef } from "react";
import { useMe } from "../auth/useMe";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { DropZone } from "../upload/DropZone";
import { AppLink } from "./AppLink";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactRow } from "./ArtifactRow";
import { Filters } from "./Filters";
import { LibraryIcon } from "./icons";
import { ALERT, BAR, Empty, GRID, H1, LIST, PAGE } from "./ui";
import { uniqueItems, useSentinel } from "./useInfinite";
import { type Scope, useLibraryQuery } from "./useLibraryQuery";

const PATH: Record<Scope, string> = {
  all: "/",
  mine: "/mine",
  shared: "/shared",
  team: "/team",
};
const TABS: { id: Scope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "shared", label: "Shared with me" },
  { id: "team", label: "Team" },
];
const VIEW_KEY = "oa.library.view";
type View = "grid" | "list";

const storedView = (): View | undefined => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "grid" || v === "list" ? v : undefined;
  } catch {
    return undefined;
  }
};
const storeView = (v: View) => {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {}
};

const EMPTY: Record<Scope, [string, React.ReactNode]> = {
  all: [
    "No artifacts yet",
    "Artifacts appear here when a connected agent publishes one.",
  ],
  mine: [
    "Ask your agent to publish something",
    <>
      Artifacts you publish show up here.{" "}
      <AppLink href="/settings/agents">
        Connect an agent in Settings → Agents
      </AppLink>
      .
    </>,
  ],
  shared: [
    "Nothing shared with you yet",
    "Artifacts others share with you appear here.",
  ],
  team: [
    "No team artifacts yet",
    "Artifacts shared with the whole team appear here.",
  ],
};

export function Library({ scope }: { scope: Scope }) {
  const me = useMe();
  useDocumentTitle(
    scope === "all"
      ? "Library"
      : (TABS.find((t) => t.id === scope)?.label ?? null),
  );
  const navigate = useNavigate();
  const s = useSearch({ strict: false }) as {
    format?: Format;
    agent?: string;
    view?: View;
  };
  const view: View = s.view ?? storedView() ?? "grid";
  const go = (to: string, search: object) =>
    void navigate({ to, search } as never);
  const set = (patch: object) => go(PATH[scope], { ...s, ...patch });

  const q = useLibraryQuery({ scope, format: s.format, agent: s.agent });
  const items = uniqueItems(q.data?.pages);
  // Remember agents seen so far so others stay selectable while one is filtered.
  const seenAgents = useRef(new Set<string>());
  for (const a of items)
    if (a.lastAgent) seenAgents.current.add(a.lastAgent.name);
  const agents = [...seenAgents.current].sort();
  const guest = me.status === "authed" && me.me.user.role === "guest";
  const meId = me.status === "authed" ? me.me.user.id : undefined;

  const sentinel = useSentinel(q);

  const filtered = Boolean(s.format || s.agent);
  const [emptyTitle, emptyText] = EMPTY[scope];

  const results = (
    <>
      <Filters
        format={s.format}
        agent={s.agent}
        agents={agents}
        view={view}
        onFormat={(format) => set({ format })}
        onAgent={(agent) => set({ agent })}
        onClear={() => set({ format: undefined, agent: undefined })}
        onView={(v) => {
          storeView(v);
          set({ view: v });
        }}
      />
      {q.isError && (
        <div className={ALERT} role="alert">
          <span className="flex-1">
            <strong>Couldn't load the library.</strong> Your artifacts are safe;
            this is usually brief.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="text-[length:var(--oa-text-sm)]"
            onClick={() => void q.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {q.isPending && !q.isError && (
        <div
          className={view === "grid" ? GRID : LIST}
          role="status"
          aria-busy="true"
          aria-label="Loading artifacts"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              key={i}
              className={view === "grid" ? "h-[180px]" : "h-10"}
            />
          ))}
        </div>
      )}
      {q.isSuccess && items.length === 0 && (
        <Empty
          icon={<LibraryIcon />}
          title={filtered ? "No artifacts match these filters" : emptyTitle}
          description={filtered ? "Try removing a filter." : emptyText}
        />
      )}
      {items.length > 0 && (
        <div className={view === "grid" ? GRID : LIST}>
          {items.map((a) =>
            view === "grid" ? (
              <ArtifactCard key={a.id} artifact={a} meId={meId} />
            ) : (
              <ArtifactRow key={a.id} artifact={a} />
            ),
          )}
        </div>
      )}
      <div ref={sentinel} className="h-px" />
    </>
  );

  return (
    <section className={PAGE}>
      <div className={BAR}>
        <h1 className={H1}>Library</h1>
        <span className="flex-1" />
        <DropZone button allowed={me.status === "authed" && !guest} />
      </div>
      {me.status === "authed" ? (
        <Tabs
          value={scope}
          onValueChange={(id) => go(PATH[id as Scope], {})}
          className="gap-[var(--oa-space-4)]"
        >
          {/* The strip scrolls, so the hairline is an inset shadow, the
              underline sits on the bottom edge and the focus ring is inset. */}
          <TabsList
            variant="line"
            className="h-[34px] w-full justify-start gap-[var(--oa-space-4)] overflow-x-auto rounded-none p-0 shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none]"
          >
            {TABS.filter((t) => !guest || t.id === "shared").map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="h-full flex-none px-0 text-[length:var(--oa-text-sm)] group-data-[orientation=horizontal]/tabs:after:bottom-0 group-data-[orientation=horizontal]/tabs:after:h-[2px] focus-visible:outline-offset-[-2px]"
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {/* Not a tab stop: Tab goes from the tabs straight to the filters. */}
          <TabsContent value={scope} tabIndex={-1} className={PAGE}>
            {results}
          </TabsContent>
        </Tabs>
      ) : (
        results
      )}
    </section>
  );
}
