import { type ArtifactSummary, viewerPath } from "@oa/shared";
import { Button, toast } from "@oa/ui";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { useArtifact, useVersionInfo } from "../api/queries";
import { useLoginRedirect } from "../auth/redirect";
import { useMe } from "../auth/useMe";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { NotFound } from "../pages/NotFound";
import { DropZone } from "../upload/DropZone";
import { createBridge } from "./bridge";
import { Crumbs } from "./Crumbs";
import { SANDBOX, safeContentUrl } from "./frame";
import { isPanelTab, type PanelTab, SidePanel } from "./panels/SidePanel";
import { TitleBar } from "./TitleBar";
import { useContentUrl } from "./useContentUrl";
import { useTheme } from "./useTheme";
import "./viewer.css";

type Bridge = ReturnType<typeof createBridge>;

function ErrorPanel({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="oa-edge" role="alert">
      <section className="oa-panel">
        <h1>Couldn't load this artifact</h1>
        <p>Something went wrong. Try again in a moment.</p>
        {onRetry && <Button onClick={onRetry}>Retry</Button>}
      </section>
    </div>
  );
}

function Viewer({
  artifact,
  version,
  explicitVersion,
  authed,
  viewer,
}: {
  artifact: ArtifactSummary;
  version: number;
  explicitVersion: boolean;
  authed: boolean;
  viewer: { email: string; name: string | null } | null;
}) {
  const content = useContentUrl(artifact.id, version);
  const url = safeContentUrl(content.url);
  const rawUrl = safeContentUrl(content.current);
  const signedOut =
    content.error instanceof ApiClientError && content.error.status === 401;
  useLoginRedirect(
    signedOut,
    viewerPath(artifact.id, explicitVersion ? version : undefined),
  );
  // The tab opens synchronously (no popup blocking) and is pointed at a URL known
  // to be fresh, refreshing a stale one first.
  const openRaw = () => {
    const w = window.open("about:blank", "_blank");
    if (!w) return;
    w.opener = null;
    const ready = content.fresh()
      ? Promise.resolve(content.current)
      : content.refresh();
    void ready.then((u) => {
      const safe = safeContentUrl(u);
      if (safe) w.location.href = safe;
      else {
        w.close();
        toast({ title: "Couldn't open the raw view", tone: "danger" });
      }
    });
  };
  const theme = useTheme();
  const [el, setEl] = useState<HTMLIFrameElement | null>(null);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    panel?: string;
    tab?: string;
  };
  const panelOpen = search.panel === "open";
  const tab: PanelTab = isPanelTab(search.tab) ? search.tab : "versions";
  const setPanel = (open: boolean, t: PanelTab = tab) =>
    void navigate({
      to: ".",
      replace: true,
      search: ((p: Record<string, unknown>) => ({
        ...p,
        panel: open ? "open" : "closed",
        tab: t,
      })) as never,
    });
  const bridge = useRef<Bridge | null>(null);
  // Latest values for the effect: the parent's key remounts this on id/version change.
  const vformat = useVersionInfo(artifact.id, version).data?.format;
  const formatRef = useRef(vformat);
  formatRef.current = vformat;
  const latest = useRef({ artifact, viewer, theme });
  latest.current = { artifact, viewer, theme };

  useEffect(() => {
    if (!el) return;
    const b = createBridge({
      iframe: el,
      ...latest.current,
      version,
      formatOf: () => formatRef.current,
      // TODO(FE11): wire thumbnail upload and PDF text extraction.
      onPdfText: () => {},
      onThumb: () => {},
    });
    bridge.current = b;
    return () => {
      b.dispose();
      bridge.current = null;
    };
  }, [el, version]);

  useEffect(() => bridge.current?.setTheme(theme), [theme]);

  if (content.notFound) return <NotFound />;
  if (signedOut) return null;
  return (
    <div className="oa-viewer">
      <Crumbs title={artifact.title} />
      <TitleBar
        artifact={artifact}
        version={version}
        explicitVersion={explicitVersion}
        rawUrl={rawUrl}
        rawBusy={content.refreshing}
        onOpenRaw={openRaw}
        authed={authed}
        onShare={() => setPanel(true, "share")}
        panelOpen={panelOpen}
        onPanel={() => setPanel(!panelOpen)}
        upload={<DropZone artifact={artifact} allowed={authed} button />}
      />
      <div className="oa-vbody">
        {!url && (content.current || content.error) ? (
          <ErrorPanel onRetry={() => void content.refresh()} />
        ) : null}
        {url && (
          <iframe
            ref={setEl}
            className="oa-vframe"
            src={url}
            onLoad={content.onLoad}
            title={artifact.title}
            sandbox={SANDBOX}
            referrerPolicy="no-referrer"
            allow="clipboard-write"
          />
        )}
        {panelOpen && authed && (
          <SidePanel
            artifact={artifact}
            tab={tab}
            onTab={(t) => setPanel(true, t)}
            onClose={() => setPanel(false)}
          />
        )}
      </div>
    </div>
  );
}

export function Shell({ id, v }: { id: string; v?: number }) {
  const q = useArtifact(id);
  const me = useMe();
  // Without an explicit version, pin the one seen first so a background bump never reloads.
  const pinned = useRef<{ id: string; v: number } | null>(null);
  if (v === undefined && q.data && pinned.current?.id !== id)
    pinned.current = { id, v: q.data.currentVersion };

  const status = q.error instanceof ApiClientError ? q.error.status : null;
  const authed = me.status === "authed";
  // Signed out mid-visit (a 401 anywhere): only a public artifact stays viewable.
  const wasAuthed = useRef(false);
  if (authed) wasAuthed.current = true;
  const expired =
    wasAuthed.current &&
    me.status === "anonymous" &&
    q.data?.visibility !== "public";
  const toLogin =
    expired ||
    status === 401 ||
    (status === 404 && (me.status === "anonymous" || me.status === "error"));
  useLoginRedirect(toLogin, viewerPath(id, v));
  // A private artifact's title is shown only to a signed-in viewer.
  useDocumentTitle(
    q.data && (authed || q.data.visibility !== "private") ? q.data.title : null,
  );

  if (toLogin) return null;
  if (status === 404 && authed) return <NotFound />;
  if (q.error && !q.data)
    return <ErrorPanel onRetry={() => void q.refetch()} />;
  if (!q.data || me.status === "loading")
    return <div className="oa-viewer" aria-busy="true" />;
  const version = v ?? pinned.current?.v ?? q.data.currentVersion;
  return (
    <Viewer
      // New id/version remounts everything, so a new document never inherits the old bridge.
      key={`${q.data.id}:${version}`}
      artifact={q.data}
      version={version}
      explicitVersion={v !== undefined}
      authed={authed}
      viewer={
        authed ? { email: me.me.user.email, name: me.me.user.name } : null
      }
    />
  );
}
