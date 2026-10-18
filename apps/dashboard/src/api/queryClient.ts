import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiClientError } from "./client";
import { qk } from "./queries";

/** No retries for client errors (4xx) or quota exhaustion; otherwise at most 2. */
export const shouldRetry = (failureCount: number, error: unknown): boolean => {
  if (
    error instanceof ApiClientError &&
    ((error.status >= 400 && error.status < 500) ||
      error.code === "quota_exceeded")
  )
    return false;
  return failureCount < 2;
};

/** Cache key of the "daily quota exhausted" flag read by QuotaBanner. */
export const QUOTA_KEY = ["quota-exceeded"] as const;

export const makeQueryClient = () => {
  const client: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: shouldRetry } },
    queryCache: new QueryCache({
      onError: (e) => reportApiError(client, e),
      onSuccess: () => reportApiSuccess(client),
    }),
    mutationCache: new MutationCache({
      onError: (e) => reportApiError(client, e),
    }),
  });
  return client;
};

/**
 * Raises the quota flag on `quota_exceeded`. A 401 anywhere means the session is
 * gone: `/me` is marked failed with it, so `useMe` turns anonymous and the
 * sign-in redirects run without refetching a `/me` that may still be cached.
 */
export const reportApiError = (client: QueryClient, error: unknown) => {
  if (!(error instanceof ApiClientError)) return;
  if (error.code === "quota_exceeded") client.setQueryData(QUOTA_KEY, true);
  if (error.status !== 401) return;
  const me = client.getQueryCache().find({ queryKey: qk.me, exact: true });
  if (!me || me.state.error === error) return;
  // An in-flight /me must not land afterwards and undo this.
  void client.cancelQueries({ queryKey: qk.me, exact: true }).then(() =>
    me.setState({
      status: "error",
      error,
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    }),
  );
};

/** Any success means the quota is available again. */
export const reportApiSuccess = (client: QueryClient) => {
  if (client.getQueryData(QUOTA_KEY)) client.setQueryData(QUOTA_KEY, false);
};
