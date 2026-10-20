import { type ArtifactSummary, type Me, viewerPath } from "@oa/shared";
import { Button } from "@oa/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { qk, useArtifact, useVersionInfo } from "../api/queries";
import { useLoginRedirect } from "../auth/redirect";
import { useMe } from "../auth/useMe";
import { useCpuSignals } from "../layout/cpu";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { NotFound } from "../pages/NotFound";
import { createBridge } from "./bridge";
import { Crumbs } from "./Crumbs";
import { SANDBOX, safeContentUrl } from "./frame";
import { isPanelTab, type PanelTab, SidePanel } from "./panels/SidePanel";
import { SlowNotice } from "./SlowNotice";
import { TitleBar } from "./TitleBar";
import { useArtifactSideEffects } from "./useArtifactSideEffects";
import { useContentUrl } from "./useContentUrl";
import { useTheme } from "./useTheme";
import "./viewer.css";
import { fullPath } from "./paths";

type Bridge = ReturnType<typeof createBridge>;

/** No hello this long after the frame loaded: hint that it may be stuck. */
export const SLOW_MS = 8_000;

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

/** Slot for the full-screen view's way back (#290): Design is picking it. */
function FullScreenEscape(_: { artifact: ArtifactSummary }) {
  return null;
}

function Viewer({
  artifact,
  version,
  explicitVersion,
  authed,
  viewer,
  role,
  plan,
  chromeless,
}: {
  chromeless: boolean;
  role: Me["user"]["role"] | undefined;
  plan: Me["instance"]["plan"] | undefined;
  artifact: ArtifactSummary;
  version: number;
  explicitVersion: boolean;
  authed: boolean;
  viewer: { email: string; name: string | null } | null;
}) {
  const content = useContentUrl(artifact.id, version);
  const url = safeContentUrl(content.url);
  const signedOut =
    content.error instanceof ApiClientError && content.error.status === 401;
  useLoginRedirect(
    signedOut,
    chromeless
      ? fullPath(artifact.id)
      : viewerPath(artifact.id, explicitVersion ? version : undefined),
  );
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
  const qc = useQueryClient();
  const fx = useArtifactSideEffects(
    artifact,
    version,
    () => bridge.current?.requestThumbnail() ?? false,
  );
  const fxRef = useRef(fx);
  fxRef.current = fx;

  // The slow notice: armed on each frame load, cleared by hello, gone for this view
  // once dismissed. Reloading remounts the frame (and so the bridge) with a fresh
  // URL; one reload per frame load, so a double click counts once.
  const cpu = useCpuSignals(role, plan);
  const helloSeen = useRef(false);
  const slowTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dismissed = useRef(false);
  const reloading = useRef(false);
  const [slow, setSlow] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [frame, setFrame] = useState<{ key: number; src: string | null }>({
    key: 0,
    src: null,
  });
  const onHello = useCallback(() => {
    helloSeen.current = true;
    clearTimeout(slowTimer.current);
    setSlow(false);
  }, []);
  const contentLoaded = content.onLoad;
  const onFrameLoad = useCallback(() => {
    contentLoaded();
    reloading.current = false;
    clearTimeout(slowTimer.current);
    if (helloSeen.current || dismissed.current) return;
    slowTimer.current = setTimeout(() => {
      if (!helloSeen.current) setSlow(true);
    }, SLOW_MS);
  }, [contentLoaded]);
  useEffect(() => () => clearTimeout(slowTimer.current), []);
  const reload = () => {
    if (reloading.current) return;
    reloading.current = true;
    helloSeen.current = false;
    clearTimeout(slowTimer.current);
    setSlow(false);
    setReloads((r) => r + 1);
    const ready = content.fresh()
      ? Promise.resolve(content.current)
      : content.refresh();
    void ready.then((u) =>
      setFrame((f) => ({ key: f.key + 1, src: safeContentUrl(u) ?? f.src })),
    );
  };

  useEffect(() => {
    if (!el) return;
    const b = createBridge({
      iframe: el,
      ...latest.current,
      version,
      formatOf: () => formatRef.current,
      onHello: () => {
        onHello();
        fxRef.current.onHello();
      },
      onPdfText: (t) => fxRef.current.onPdfText(t),
      onThumb: (b) => fxRef.current.onThumb(b),
      // The refetch 404s if access is gone, which the shell then handles.
      onAccessLost: () =>
        void qc.invalidateQueries({ queryKey: qk.artifact(artifact.id) }),
    });
    bridge.current = b;
    return () => {
      b.dispose();
      bridge.current = null;
    };
  }, [el, version, qc, artifact.id, onHello]);

  useEffect(() => bridge.current?.setTheme(theme), [theme]);

  if (content.notFound) return <NotFound />;
  if (signedOut) return null;
  return (
    <div className="oa-viewer">
      {chromeless ? (
        <FullScreenEscape artifact={artifact} />
      ) : (
        <>
          <Crumbs title={artifact.title} />
          <TitleBar
            artifact={artifact}
            version={version}
            explicitVersion={explicitVersion}
            authed={authed}
            onShare={() => setPanel(true, "share")}
            panelOpen={panelOpen}
            onPanel={() => setPanel(!panelOpen)}
          />
        </>
      )}
      <div className="oa-vbody">
        {!url && (content.current || content.error) ? (
          <ErrorPanel onRetry={() => void content.refresh()} />
        ) : null}
        {url && (
          <div className="oa-vmain">
            {slow && (
              <SlowNotice
                cpu={(cpu.hits ?? 0) > 0 || cpu.recent}
                reloads={reloads}
                admin={cpu.admin}
                paid={cpu.paid}
                onReload={reload}
                onDismiss={() => {
                  dismissed.current = true;
                  clearTimeout(slowTimer.current);
                  setSlow(false);
                }}
              />
            )}
            <iframe
              key={frame.key}
              ref={setEl}
              className="oa-vframe"
              src={frame.src ?? url}
              onLoad={onFrameLoad}
              title={artifact.title}
              sandbox={SANDBOX}
              referrerPolicy="no-referrer"
              allow="clipboard-write"
            />
          </div>
        )}
        {panelOpen && authed && !chromeless && (
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

/** The artifact viewer; `chromeless` is the full-screen view (#290): the frame
    and bridge only, with the same access and loading states. */
export function Shell({
  id,
  v,
  chromeless = false,
}: {
  id: string;
  v?: number;
  chromeless?: boolean;
}) {
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
  useLoginRedirect(toLogin, chromeless ? fullPath(id) : viewerPath(id, v));
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
      chromeless={chromeless}
      authed={authed}
      role={authed ? me.me.user.role : undefined}
      plan={authed ? me.me.instance.plan : undefined}
      viewer={
        authed ? { email: me.me.user.email, name: me.me.user.name } : null
      }
    />
  );
}
