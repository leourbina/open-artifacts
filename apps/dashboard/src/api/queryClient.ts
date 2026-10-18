import { QueryClient } from "@tanstack/react-query";
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

export const makeQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });
