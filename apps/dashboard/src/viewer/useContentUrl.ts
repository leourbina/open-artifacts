import { type ContentUrl, ContentUrlSchema, LIMITS, R } from "@oa/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

const RETRY_MS = 15_000;

/**
 * Signed content URL, refetched 60 s before it expires (null expiry: never).
 * `url` follows refreshes only until the iframe fires `onLoad`; after that it is
 * frozen so a refresh never reloads the loaded document.
 */
export function useContentUrl(id: string, v: number) {
  const [fresh, setFresh] = useState<ContentUrl | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setFresh(null);
    setLoaded(null);
    const load = () => {
      api.get(R.contentUrl(id, v), ContentUrlSchema).then(
        (c) => {
          if (dead) return;
          setFresh(c);
          if (c.expiresAt === null) return;
          // Relative to local fetch time, so client clock skew can't matter.
          timer = setTimeout(
            load,
            Number.isFinite(Date.parse(c.expiresAt))
              ? (LIMITS.signedUrlTtlSec - 60) * 1000
              : RETRY_MS,
          );
        },
        () => {
          if (!dead) timer = setTimeout(load, RETRY_MS);
        },
      );
    };
    load();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [id, v]);

  const url = loaded ?? fresh?.url ?? null;
  const onLoad = useCallback(
    () => setLoaded((l) => l ?? fresh?.url ?? null),
    [fresh],
  );
  return { url, onLoad };
}
