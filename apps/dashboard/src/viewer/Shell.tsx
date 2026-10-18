import { type ArtifactSummary, AUTH, viewerPath } from "@oa/shared";
import { Button } from "@oa/ui";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { useArtifact } from "../api/queries";
import { useRedirect } from "../auth/redirect";
import { useMe } from "../auth/useMe";
import { NotFound } from "../pages/NotFound";
import { createBridge } from "./bridge";
import { TitleBar } from "./TitleBar";
import { useContentUrl } from "./useContentUrl";
import { useTheme } from "./useTheme";
import "./viewer.css";

type Bridge = ReturnType<typeof createBridge>;

/** Only http(s) URLs on another origin may be framed or linked as raw content. */
const safeContentUrl = (u: string | null) => {
  if (!u) return null;
  try {
    const p = new URL(u);
    return (p.protocol === "https:" || p.protocol === "http:") &&
      p.origin !== location.origin
      ? u
      : null;
  } catch {
    return null;
  }
};

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
  const theme = useTheme();
  const [el, setEl] = useState<HTMLIFrameElement | null>(null);
  const [panel, setPanel] = useState<"share" | null>(null);
  const bridge = useRef<Bridge | null>(null);
  // Latest values for the effect: the parent's key remounts this on id/version change.
  const latest = useRef({ artifact, viewer, theme });
  latest.current = { artifact, viewer, theme };

  useEffect(() => {
    if (!el) return;
    const b = createBridge({
      iframe: el,
      ...latest.current,
      version,
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
  return (
    <div className="oa-viewer">
      <TitleBar
        artifact={artifact}
        version={version}
        explicitVersion={explicitVersion}
        rawUrl={rawUrl}
        authed={authed}
        onShare={() => setPanel("share")}
      />
      <div className="oa-vbody">
        {content.current && !url && <ErrorPanel />}
        {url && (
          <iframe
            ref={setEl}
            className="oa-vframe"
            src={url}
            onLoad={content.onLoad}
            title={artifact.title}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            referrerPolicy="no-referrer"
            allow="clipboard-write"
          />
        )}
        {panel && (
          // TODO(FE6): replace with the real Share panel.
          <aside className="oa-vpanel" aria-label="Side panel">
            Sharing settings are coming soon.
          </aside>
        )}
      </div>
    </div>
  );
}

export function Shell({ id, v }: { id: string; v?: number }) {
  const q = useArtifact(id);
  const me = useMe();
  const redirect = useRedirect();
  // Without an explicit version, pin the one seen first so a background bump never reloads.
  const pinned = useRef<{ id: string; v: number } | null>(null);
  if (v === undefined && q.data && pinned.current?.id !== id)
    pinned.current = { id, v: q.data.currentVersion };

  const status = q.error instanceof ApiClientError ? q.error.status : null;
  const authed = me.status === "authed";
  const toLogin =
    status === 401 ||
    (status === 404 && (me.status === "anonymous" || me.status === "error"));
  useEffect(() => {
    if (toLogin)
      redirect(`${AUTH.login}?next=${encodeURIComponent(viewerPath(id, v))}`);
  }, [toLogin, redirect, id, v]);

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
