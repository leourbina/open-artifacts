import type { ArtifactSummary } from "@oa/shared";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { useArtifact } from "../api/queries";
import { useMe } from "../auth/useMe";
import { NotFound } from "../pages/NotFound";
import { createBridge } from "./bridge";
import { TitleBar } from "./TitleBar";
import { useContentUrl } from "./useContentUrl";
import { useTheme } from "./useTheme";
import "./viewer.css";

type Bridge = ReturnType<typeof createBridge>;

function Viewer({
  artifact,
  version,
  authed,
  viewer,
}: {
  artifact: ArtifactSummary;
  version: number;
  authed: boolean;
  viewer: { email: string; name: string | null } | null;
}) {
  const { url, onLoad } = useContentUrl(artifact.id, version);
  const theme = useTheme();
  const [el, setEl] = useState<HTMLIFrameElement | null>(null);
  const [panel, setPanel] = useState<"share" | null>(null);
  const bridge = useRef<Bridge | null>(null);
  // Latest values for the effect, which is keyed only on (id, version, element).
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: see `latest`
  }, [el, artifact.id, version]);

  useEffect(() => bridge.current?.setTheme(theme), [theme]);

  return (
    <div className="oa-viewer">
      <TitleBar
        artifact={artifact}
        version={version}
        rawUrl={url}
        authed={authed}
        onShare={() => setPanel("share")}
      />
      <div className="oa-vbody">
        {url && (
          <iframe
            ref={setEl}
            className="oa-vframe"
            src={url}
            onLoad={onLoad}
            title={artifact.title}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            referrerPolicy="no-referrer"
            allow="clipboard-write"
          />
        )}
        {panel && (
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
  // Never reveal whether an inaccessible artifact exists: 404 and 401 look alike.
  if (
    q.error instanceof ApiClientError &&
    (q.error.status === 404 || q.error.status === 401)
  )
    return <NotFound />;
  if (!q.data || me.status === "loading")
    return <div className="oa-viewer" aria-busy="true" />;
  const authed = me.status === "authed";
  return (
    <Viewer
      // New id/version remounts everything, so a new document never inherits the old bridge.
      key={`${q.data.id}:${v ?? q.data.currentVersion}`}
      artifact={q.data}
      version={v ?? q.data.currentVersion}
      authed={authed}
      viewer={
        authed ? { email: me.me.user.email, name: me.me.user.name } : null
      }
    />
  );
}
