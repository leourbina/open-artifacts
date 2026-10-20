import { useCallback, useRef } from "react";

/**
 * Runs `start` unless a previous run hasn't settled. The flag is a ref set
 * synchronously: a mutation's `isPending` only turns true on a later render,
 * so two submits in one tick (a fast double Enter or click) would both pass an
 * `isPending` check. `start` receives `done`, to call when the request settles
 * (e.g. as `onSettled`).
 */
export function useSingleFlight() {
  const flying = useRef(false);
  return useCallback((start: (done: () => void) => void) => {
    if (flying.current) return;
    flying.current = true;
    start(() => {
      flying.current = false;
    });
  }, []);
}
