import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiClientError } from "./client";

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
      onError: (e) => flagQuota(client, e),
      onSuccess: () => {
        if (client.getQueryData(QUOTA_KEY))
          client.setQueryData(QUOTA_KEY, false);
      },
    }),
    mutationCache: new MutationCache({ onError: (e) => flagQuota(client, e) }),
  });
  return client;
};

const flagQuota = (client: QueryClient, error: unknown) => {
  if (error instanceof ApiClientError && error.code === "quota_exceeded")
    client.setQueryData(QUOTA_KEY, true);
};
