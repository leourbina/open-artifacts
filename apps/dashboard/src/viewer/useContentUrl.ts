import { type ContentUrl, ContentUrlSchema, LIMITS, R } from "@oa/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiClientError, api } from "../api/client";

const RETRY_MS = 15_000;

/**
 * Signed content URL, refetched 60 s before it expires (null expiry: never).
 * `url` follows refreshes only until the iframe fires `onLoad`; after that it is
 * frozen so a refresh never reloads the loaded document. `current` always follows
 * refreshes (for links opened outside the iframe). `notFound` stops retrying.
 */
export function useContentUrl(id: string, v: number) {
  const [fresh, setFresh] = useState<ContentUrl | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setFresh(null);
    setLoaded(null);
    setNotFound(false);
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
        (e) => {
          if (dead) return;
          if (e instanceof ApiClientError && e.status === 404) {
            setNotFound(true);
            return;
          }
          timer = setTimeout(load, RETRY_MS);
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
  return { url, current: fresh?.url ?? null, onLoad, notFound };
}
