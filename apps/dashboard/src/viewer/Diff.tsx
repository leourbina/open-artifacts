import {
  type FileEntry,
  isTextContentType,
  R,
  type VersionInfo,
} from "@oa/shared";
import { Button, Tabs } from "@oa/ui";
import { useQuery } from "@tanstack/react-query";
import { diffLines } from "diff";
import { useMemo, useState } from "react";
import { ApiClientError, api } from "../api/client";
import { useArtifact, useVersionInfo } from "../api/queries";
import { NotFound } from "../pages/NotFound";
import { Crumbs } from "./Crumbs";
import { SANDBOX, safeContentUrl } from "./frame";
import { useContentUrl } from "./useContentUrl";
import "./viewer.css";

const MAX_BYTES = 1_000_000;
const CONTEXT = 3;

type Row = {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

export function diffRows(a: string, b: string): Row[] | null {
  const parts = diffLines(a, b, { maxEditLength: 20_000 });
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

function Unified({ rows }: { rows: Row[] }) {
  const [all, setAll] = useState(false);
  const shown = useMemo(() => {
    const keep = new Array<boolean>(rows.length).fill(all);
    if (!all)
      rows.forEach((r, i) => {
        if (r.kind === "ctx") return;
        for (let j = i - CONTEXT; j <= i + CONTEXT; j++) keep[j] = true;
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
    return out;
  }, [rows, all]);
  if (!rows.some((r) => r.kind !== "ctx")) return <p>No changes.</p>;
  const hiddenAny = shown.some((r) => "gap" in r);
  return (
    <>
      <table className="oa-dtable">
        <tbody>
          {shown.map((r, i) =>
            "gap" in r ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: static list
              <tr key={i} data-kind="gap">
                <td colSpan={4}>{r.gap} unchanged lines</td>
              </tr>
            ) : (
              <tr key={`${r.oldNo}:${r.newNo}`} data-kind={r.kind}>
                <td className="n">{r.oldNo}</td>
                <td className="n">{r.newNo}</td>
                <td>{r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}</td>
                <td>{r.text}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {(hiddenAny || all) && (
        <Button size="sm" onClick={() => setAll(!all)}>
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
  path,
  a,
  b,
}: {
  id: string;
  from: number;
  to: number;
  path: string;
  a?: FileEntry;
  b?: FileEntry;
}) {
  const q = useQuery({
    queryKey: ["artifact", id, "diff", from, to, path, a?.size, b?.size],
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
  if (!rows) return <p>Too many differences to display.</p>;
  return <Unified rows={rows} />;
}

type Status = "added" | "removed" | "changed" | "same";
const status = (a?: FileEntry, b?: FileEntry): Status =>
  !a ? "added" : !b ? "removed" : a.size !== b.size ? "changed" : "same";
const LABEL: Record<Status, string> = {
  added: "Added",
  removed: "Removed",
  changed: "Changed",
  same: "Same size",
};

function Preview({ id, v }: { id: string; v: number }) {
  const c = useContentUrl(id, v);
  const url = safeContentUrl(c.url);
  return (
    <figure>
      <figcaption>v{v}</figcaption>
      {url && (
        <iframe
          src={url}
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
  format,
}: {
  id: string;
  from: number;
  to: number;
  a: VersionInfo;
  b: VersionInfo;
  format: string;
}) {
  const paths = [
    ...new Set([...a.files.map((f) => f.path), ...b.files.map((f) => f.path)]),
  ];
  const find = (v: VersionInfo, p: string) => v.files.find((f) => f.path === p);
  const [picked, setPicked] = useState<string | null>(null);
  const path = picked ?? (paths.includes(b.entry) ? b.entry : paths[0]);
  const source = (
    <>
      <ul className="oa-dfiles" aria-label="Files">
        {paths.map((p) => {
          const s = status(find(a, p), find(b, p));
          return (
            <li key={p}>
              <button
                type="button"
                aria-current={p === path}
                onClick={() => setPicked(p)}
              >
                {p}
              </button>{" "}
              <span className="oa-muted">{LABEL[s]}</span>
            </li>
          );
        })}
      </ul>
      {path && (
        <FileDiff
          key={path}
          id={id}
          from={from}
          to={to}
          path={path}
          a={find(a, path)}
          b={find(b, path)}
        />
      )}
    </>
  );
  const previewable = format === "html" || format === "markdown";
  if (!previewable) return source;
  return (
    <Tabs
      tabs={[
        { id: "source", label: "Source diff", content: source },
        {
          id: "preview",
          label: "Preview",
          content: (
            <div className="oa-dpreview">
              <Preview id={id} v={from} />
              <Preview id={id} v={to} />
            </div>
          ),
        },
      ]}
    />
  );
}

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
  const err = [art, a, b].find((q) => q.error)?.error;
  if (err instanceof ApiClientError && err.status === 404) return <NotFound />;
  if (err) return <p role="alert">Couldn't load this comparison.</p>;
  if (!art.data || a.isPending || b.isPending)
    return <div className="oa-diff" aria-busy="true" />;
  if (!a.data || !b.data) return <NotFound />;
  return (
    <div className="oa-viewer">
      <Crumbs title={art.data.title} />
      <div className="oa-diff">
        <h1>
          Compare v{from} → v{to}
        </h1>
        <Compare
          id={id}
          from={from}
          to={to}
          a={a.data}
          b={b.data}
          format={art.data.format}
        />
      </div>
    </div>
  );
}
