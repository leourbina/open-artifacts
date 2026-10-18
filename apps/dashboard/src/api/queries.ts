import {
  type ArtifactPatch,
  ArtifactPatchSchema,
  ArtifactSummarySchema,
  type ListQueryInput,
  MemberSchema,
  MeSchema,
  OAuthClientSchema,
  PageSchema,
  type PublishInput,
  PublishResultSchema,
  R,
  SearchHitSchema,
  SettingsSchema,
  type ShareInput,
  ShareSchema,
  TokenSchema,
  UsageSchema,
  VersionInfoSchema,
} from "@oa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client";

export type SearchQuery = { q: string; cursor?: string; limit?: number };

export const qk = {
  me: ["me"] as const,
  artifacts: (q: ListQueryInput) => ["artifacts", q] as const,
  artifact: (id: string) => ["artifact", id] as const,
  versions: (id: string) => ["artifact", id, "versions"] as const,
  shares: (id: string) => ["artifact", id, "shares"] as const,
  search: (q: SearchQuery) => ["search", q] as const,
  members: ["members"] as const,
  tokens: ["tokens"] as const,
  oauthClients: ["oauth-clients"] as const,
  settings: ["settings"] as const,
  usage: ["usage"] as const,
};

const withQuery = (path: string, q: object) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
};

const ArtifactPage = PageSchema(ArtifactSummarySchema);
const SearchPage = PageSchema(SearchHitSchema);

export const useMe = () =>
  useQuery({
    queryKey: qk.me,
    queryFn: () => api.get(R.me, MeSchema),
    retry: false,
  });
export const useArtifacts = (q: ListQueryInput) =>
  useQuery({
    queryKey: qk.artifacts(q),
    queryFn: () => api.get(withQuery(R.artifacts, q), ArtifactPage),
  });
export const useArtifact = (id: string) =>
  useQuery({
    queryKey: qk.artifact(id),
    queryFn: () => api.get(R.artifact(id), ArtifactSummarySchema),
  });
export const useVersions = (id: string) =>
  useQuery({
    queryKey: qk.versions(id),
    queryFn: () => api.get(R.versions(id), z.array(VersionInfoSchema)),
  });
export const useShares = (id: string) =>
  useQuery({
    queryKey: qk.shares(id),
    queryFn: () => api.get(R.shares(id), z.array(ShareSchema)),
  });
export const useSearch = (q: SearchQuery) =>
  useQuery({
    queryKey: qk.search(q),
    queryFn: () => api.get(withQuery(R.search, q), SearchPage),
    enabled: q.q.length > 0,
  });
export const useMembers = () =>
  useQuery({
    queryKey: qk.members,
    queryFn: () => api.get(R.members, z.array(MemberSchema)),
  });
export const useTokens = () =>
  useQuery({
    queryKey: qk.tokens,
    queryFn: () => api.get(R.tokens, z.array(TokenSchema)),
  });
export const useOAuthClients = () =>
  useQuery({
    queryKey: qk.oauthClients,
    queryFn: () => api.get(R.oauthClients, z.array(OAuthClientSchema)),
  });
export const useSettings = () =>
  useQuery({
    queryKey: qk.settings,
    queryFn: () => api.get(R.settings, SettingsSchema),
  });
export const useUsage = () =>
  useQuery({
    queryKey: qk.usage,
    queryFn: () => api.get(R.usage, UsageSchema),
  });

/** Run `fn` then invalidate every key `keys()` returns. */
const useInvalidating = <V, T>(
  fn: (v: V) => Promise<T>,
  keys: () => (readonly unknown[])[],
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      Promise.all(keys().map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
};

const artifactKeys = (id: string) => () => [qk.artifact(id), ["artifacts"]];

export const usePublishVersion = (id: string) =>
  useInvalidating(
    (input: PublishInput) =>
      api.send("POST", R.versions(id), input, PublishResultSchema),
    () => [...artifactKeys(id)(), qk.versions(id)],
  );
export const usePatchArtifact = (id: string) =>
  useInvalidating(
    (patch: ArtifactPatch) =>
      api.send(
        "PATCH",
        R.artifact(id),
        ArtifactPatchSchema.parse(patch),
        ArtifactSummarySchema,
      ),
    artifactKeys(id),
  );
export const useDeleteArtifact = (id: string) =>
  useInvalidating(
    () => api.send("DELETE", R.artifact(id), undefined),
    artifactKeys(id),
  );
export const usePutShare = (id: string) =>
  useInvalidating(
    (input: ShareInput) => api.send("PUT", R.shares(id), input, ShareSchema),
    () => [qk.shares(id)],
  );
export const useDeleteShare = (id: string) =>
  useInvalidating(
    (email: string) => api.send("DELETE", R.share(id, email), undefined),
    () => [qk.shares(id)],
  );
