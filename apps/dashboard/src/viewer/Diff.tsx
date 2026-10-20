import {
  diffPath,
  type FileEntry,
  isTextContentType,
  R,
  type VersionInfo,
} from "@oa/shared";
import {
  Badge,
  Button,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { diffLines } from "diff";
import { useEffect, useMemo, useState } from "react";
import { ApiClientError, api } from "../api/client";
import { useArtifact, useVersionInfo } from "../api/queries";
import { useLoginRedirect } from "../auth/redirect";
import { useMe } from "../auth/useMe";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { NotFound } from "../pages/NotFound";
import { Crumbs } from "./Crumbs";
import { loadArtifactFrame, SANDBOX, safeContentUrl } from "./frame";
import { SM, TXT } from "./ui";
import { useContentUrl } from "./useContentUrl";
import "./viewer.css";

const MAX_BYTES = 1_000_000;
const CONTEXT = 3;
const CHUNK = 2000;

type Row = {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

export function diffRows(a: string, b: string): Row[] | null {
  const side = (text: string, kind: "add" | "del"): Row[] => {
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.map((t, i) => ({
      kind,
      text: t,
      oldNo: kind === "del" ? i + 1 : null,
      newNo: kind === "add" ? i + 1 : null,
    }));
  };
  if (a === "") return side(b, "add");
  if (b === "") return side(a, "del");
  // Bounded so a pathological pair of files can't freeze the tab.
  const parts = diffLines(a, b, { maxEditLength: 20_000, timeout: 500 });
  if (!parts) return null;
  const rows: Row[] = [];
  let o = 1;
  let n = 1;
  for (const p of parts) {
    const lines = p.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const text of lines) {
      if (p.added) rows.push({ kind: "add", text, oldNo: null, newNo: n++ });
      else if (p.removed)
        rows.push({ kind: "del", text, oldNo: o++, newNo: null });
      else rows.push({ kind: "ctx", text, oldNo: o++, newNo: n++ });
    }
  }
  return rows;
}

const CELL = "px-2 align-top break-all whitespace-pre-wrap";
const NUM = `${CELL} w-[1%] text-right text-muted-foreground select-none`;
const GAP_ROW = "bg-[var(--oa-sunken)] text-muted-foreground";

function Unified({ rows }: { rows: Row[] }) {
  const [all, setAll] = useState(false);
  const [limit, setLimit] = useState(CHUNK);
  const { shown, truncated } = useMemo(() => {
    const keep = new Array<boolean>(rows.length).fill(all);
    if (!all)
      rows.forEach((r, i) => {
        if (r.kind === "ctx") return;
        for (
          let j = Math.max(0, i - CONTEXT);
          j <= Math.min(rows.length - 1, i + CONTEXT);
          j++
        )
          keep[j] = true;
      });
    const out: (Row | { gap: number })[] = [];
    let hidden = 0;
    rows.forEach((r, i) => {
      if (keep[i]) {
        if (hidden) out.push({ gap: hidden });
        hidden = 0;
        out.push(r);
      } else hidden++;
    });
    if (hidden) out.push({ gap: hidden });
    return { shown: out.slice(0, limit), truncated: out.length > limit };
  }, [rows, all, limit]);
  if (!rows.some((r) => r.kind !== "ctx")) return <p>No changes.</p>;
  const hiddenAny = all || shown.some((r) => "gap" in r);
  return (
    <>
      <table className="w-full border-collapse font-mono text-[length:var(--oa-text-xs)] leading-normal">
        <thead className="sr-only">
          <tr>
            <th>Old line</th>
            <th>New line</th>
            <th>Change</th>
            <th>Text</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) =>
            "gap" in r ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: static list
              <tr key={i} data-kind="gap" className={GAP_ROW}>
                <td colSpan={4} className={CELL}>
                  {r.gap} unchanged lines
                </td>
              </tr>
            ) : (
              <tr
                key={`${r.oldNo}:${r.newNo}`}
                data-kind={r.kind}
                className="data-[kind=add]:bg-[var(--oa-success-soft)] data-[kind=del]:bg-[var(--oa-danger-soft)]"
              >
                <td className={NUM}>{r.oldNo}</td>
                <td className={NUM}>{r.newNo}</td>
                <td className={CELL}>
                  {r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}
                </td>
                <td className={CELL}>{r.text}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {truncated && (
        <Button
          variant="outline"
          size="xs"
          className={`${SM} self-start`}
          onClick={() => setLimit(limit + CHUNK)}
        >
          Show {CHUNK} more
        </Button>
      )}
      {(hiddenAny || all) && (
        <Button
          variant="outline"
          size="xs"
          className={`${SM} self-start`}
          onClick={() => {
            setAll(!all);
            setLimit(CHUNK);
          }}
        >
          {all ? "Show changes only" : "Show all"}
        </Button>
      )}
    </>
  );
}

type Side = { text: string; binary: boolean; big: boolean };
const EMPTY: Side = { text: "", binary: false, big: false };

async function loadSide(
  id: string,
  v: number,
  file: FileEntry | undefined,
  signal: AbortSignal,
): Promise<Side> {
  if (!file) return EMPTY;
  if (!isTextContentType(file.contentType))
    return { text: "", binary: true, big: false };
  if (file.size > MAX_BYTES) return { text: "", binary: false, big: true };
  const { text } = await api.getText(R.versionFile(id, v, file.path), signal);
  if (text.length > MAX_BYTES) return { text: "", binary: false, big: true };
  return { text, binary: text.slice(0, 8192).includes("\0"), big: false };
}

function FileDiff({
  id,
  from,
  to,
  a,
  b,
}: {
  id: string;
  from: number;
  to: number;
  a?: FileEntry;
  b?: FileEntry;
}) {
  const q = useQuery({
    queryKey: [
      "artifact",
      id,
      "diff",
      from,
      to,
      a?.path,
      b?.path,
      a?.size,
      b?.size,
    ],
    queryFn: async ({ signal }) =>
      Promise.all([loadSide(id, from, a, signal), loadSide(id, to, b, signal)]),
  });
  const rows = useMemo(
    () =>
      q.data && !q.data.some((s) => s.binary || s.big)
        ? diffRows(q.data[0].text, q.data[1].text)
        : null,
    [q.data],
  );
  if (q.error) return <p role="alert">Couldn't load this file.</p>;
  if (!q.data) return <p aria-busy="true">Loading…</p>;
  if (q.data.some((s) => s.binary)) return <p>Binary file changed</p>;
  if (q.data.some((s) => s.big)) return <p>File too large to diff</p>;
  if (!rows)
    return (
      <p>
        Too many differences to display. Download both:{" "}
        {a && (
          <a
            className="underline underline-offset-2"
            href={R.versionFile(id, from, a.path)}
            download
          >
            v{from}
          </a>
        )}{" "}
        {b && (
          <a
            className="underline underline-offset-2"
            href={R.versionFile(id, to, b.path)}
            download
          >
            v{to}
          </a>
        )}
      </p>
    );
  return <Unified rows={rows} />;
}

type Status = "added" | "removed" | "changed" | "same";
const status = (a?: FileEntry, b?: FileEntry): Status =>
  !a ? "added" : !b ? "removed" : a.size !== b.size ? "changed" : "same";
const LABEL: Record<Status, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  same: "No size change",
};

function Preview({ id, v, label }: { id: string; v: number; label: string }) {
  const c = useContentUrl(id, v);
  const url = safeContentUrl(c.url);
  // No bridge here, but every artifact frame loads through loadArtifactFrame.
  const [el, setEl] = useState<HTMLIFrameElement | null>(null);
  useEffect(() => {
    if (el && url) loadArtifactFrame(el, url);
  }, [el, url]);
  return (
    <figure>
      <figcaption>
        {label} (v{v})
      </figcaption>
      {url && (
        <iframe
          ref={setEl}
          title={`Preview of v${v}`}
          sandbox={SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={c.onLoad}
        />
      )}
    </figure>
  );
}

function Compare({
  id,
  from,
  to,
  a,
  b,
}: {
  id: string;
  from: number;
  to: number;
  a: VersionInfo;
  b: VersionInfo;
}) {
  const paths = [
    ...new Set([...a.files.map((f) => f.path), ...b.files.map((f) => f.path)]),
  ];
  const find = (v: VersionInfo, p: string) => v.files.find((f) => f.path === p);
  const [picked, setPicked] = useState<string | null>(null);
  const fa = picked ? find(a, picked) : find(a, a.entry);
  const fb = picked ? find(b, picked) : find(b, b.entry);
  const path = picked ?? b.entry;
  const source = (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1 p-0" aria-label="Files">
        {paths.map((p) => {
          const s = status(find(a, p), find(b, p));
          return (
            <li key={p} className="flex min-w-0 items-center gap-2">
              <Button
                variant="ghost"
                size="xs"
                className="min-w-0 justify-start px-2 font-mono text-[length:var(--oa-text-sm)] aria-[current=true]:bg-accent aria-[current=true]:font-semibold"
                aria-current={p === path}
                onClick={() => setPicked(p)}
              >
                <span className="truncate">{p}</span>
              </Button>
              <Badge
                variant="outline"
                className="ml-auto text-muted-foreground"
              >
                {LABEL[s]}
              </Badge>
            </li>
          );
        })}
      </ul>
      <FileDiff
        key={`${fa?.path}:${fb?.path}`}
        id={id}
        from={from}
        to={to}
        a={fa}
        b={fb}
      />
    </div>
  );
  const previewable = [a, b].every(
    (v) => v.format === "html" || v.format === "markdown",
  );
  if (!previewable) return source;
  return (
    <Tabs defaultValue="source">
      <TabsList
        variant="line"
        className="h-auto w-full justify-start gap-1 border-0 border-b border-border p-0"
      >
        {[
          ["source", "Source diff"],
          ["preview", "Preview"],
        ].map(([v, label]) => (
          <TabsTrigger
            key={v}
            value={v as string}
            className={`h-[34px] flex-none rounded-sm px-3 ${TXT}`}
          >
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="source" className="pt-3">
        {source}
      </TabsContent>
      <TabsContent value="preview" className="pt-3">
        <div className="oa-dpreview">
          <Preview id={id} v={from} label="Before" />
          <Preview id={id} v={to} label="After" />
        </div>
      </TabsContent>
    </Tabs>
  );
}

const DIFF = "flex flex-col gap-3 px-5 py-4 max-[600px]:px-4";

export function Diff({
  id,
  from,
  to,
}: {
  id: string;
  from: number;
  to: number;
}) {
  const art = useArtifact(id);
  const a = useVersionInfo(id, from);
  const b = useVersionInfo(id, to);
  const me = useMe();
  const err = [art, a, b].find((q) => q.error)?.error;
  const status = err instanceof ApiClientError ? err.status : null;
  // Same sign-in rule as the viewer: /a/* is public, so 401s are handled here.
  const toLogin =
    status === 401 ||
    (status === 404 && (me.status === "anonymous" || me.status === "error"));
  useLoginRedirect(toLogin, diffPath(id, from, to));
  useDocumentTitle(
    art.data && (me.status === "authed" || art.data.visibility !== "private")
      ? `${art.data.title} v${from} → v${to}`
      : null,
  );
  if (toLogin) return null;
  if (status === 404 && me.status === "authed") return <NotFound />;
  if (err && status !== 404)
    return <p role="alert">Couldn't load this comparison.</p>;
  if (!art.data || a.isPending || b.isPending)
    return (
      <div className={DIFF} aria-busy="true">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  if (!a.data || !b.data) return <NotFound />;
  return (
    <div className="oa-viewer">
      <Crumbs title={art.data.title} />
      <div className={DIFF}>
        <h1 className="text-[length:var(--oa-text-xl)] leading-tight font-semibold">
          Compare v{from} → v{to}
        </h1>
        <Compare id={id} from={from} to={to} a={a.data} b={b.data} />
      </div>
    </div>
  );
}
