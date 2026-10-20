import {
  type ArtifactPatch,
  ArtifactSummarySchema,
  type ListQueryInput,
  ListQuerySchema,
  type Member,
  type MemberInvite,
  MemberInviteResultSchema,
  type MemberPatch,
  MemberSchema,
  type MePatch,
  MeSchema,
  OAuthClientSchema,
  PageSchema,
  type PublishInput,
  PublishResultSchema,
  R,
  SearchHitSchema,
  type SettingsPatch,
  SettingsSchema,
  type ShareInput,
  ShareResultSchema,
  ShareSchema,
  TokenSchema,
  UsageSchema,
  VersionInfoSchema,
} from "@oa/shared";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "../layout/toast";
import { ApiClientError, api } from "./client";

const failToast = (e: unknown, fallback: string) =>
  toast({
    title: e instanceof ApiClientError ? e.message : fallback,
    tone: "danger",
  });

export type SearchQuery = { q: string; cursor?: string; limit?: number };

export const qk = {
  me: ["me"] as const,
  artifacts: (q: ListQueryInput) =>
    ["artifacts", ListQuerySchema.parse(q)] as const,
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

export const useArtifacts = (q: ListQueryInput) =>
  useQuery({
    queryKey: qk.artifacts(q),
    queryFn: ({ signal }) =>
      api.get(withQuery(R.artifacts, q), ArtifactPage, signal),
  });
export const useArtifact = (id: string) =>
  useQuery({
    queryKey: qk.artifact(id),
    queryFn: ({ signal }) =>
      api.get(R.artifact(id), ArtifactSummarySchema, signal),
  });
export const useVersions = (id: string, opts?: { enabled?: boolean }) =>
  useQuery({
    enabled: opts?.enabled ?? true,
    queryKey: qk.versions(id),
    queryFn: ({ signal }) =>
      api.get(R.versions(id), z.array(VersionInfoSchema), signal),
  });
/**
 * Timeline pages, newest first; each next page is `before` the last version seen.
 * Pages may be short (contract C2), so only an empty page ends the timeline.
 */
export const useVersionPages = (id: string) =>
  useInfiniteQuery({
    queryKey: [...qk.versions(id), "pages"] as const,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get(R.versions(id, pageParam), z.array(VersionInfoSchema), signal),
    getNextPageParam: (last) => last[last.length - 1]?.version,
  });
/** Info for one version, however old: the first item of the page just below `v + 1`. */
export const useVersionInfo = (id: string, v: number, enabled = true) =>
  useQuery({
    enabled,
    queryKey: [...qk.versions(id), v] as const,
    queryFn: async ({ signal }) =>
      (
        await api.get(R.versions(id, v + 1), z.array(VersionInfoSchema), signal)
      ).find((x) => x.version === v) ?? null,
  });
export const useShares = (id: string) =>
  useQuery({
    queryKey: qk.shares(id),
    queryFn: ({ signal }) =>
      api.get(R.shares(id), z.array(ShareSchema), signal),
  });
export const useSearch = (q: SearchQuery) =>
  useQuery({
    queryKey: qk.search(q),
    queryFn: ({ signal }) =>
      api.get(withQuery(R.search, q), SearchPage, signal),
    enabled: q.q.length > 0,
  });
export const useMembers = () =>
  useQuery({
    queryKey: qk.members,
    queryFn: ({ signal }) => api.get(R.members, z.array(MemberSchema), signal),
  });
export const useTokens = () =>
  useQuery({
    queryKey: qk.tokens,
    queryFn: ({ signal }) => api.get(R.tokens, z.array(TokenSchema), signal),
  });
export const useOAuthClients = () =>
  useQuery({
    queryKey: qk.oauthClients,
    queryFn: ({ signal }) =>
      api.get(R.oauthClients, z.array(OAuthClientSchema), signal),
  });
export const useRevokeToken = () =>
  useInvalidating(
    (id: string) => api.send("DELETE", R.token(id), undefined),
    () => [qk.tokens],
    "Couldn't revoke the token.",
  );
export const useRevokeOAuthClient = () =>
  useInvalidating(
    (grantId: string) => api.send("DELETE", R.oauthClient(grantId), undefined),
    () => [qk.oauthClients],
    "Couldn't revoke the agent.",
  );
export const useSettings = () =>
  useQuery({
    queryKey: qk.settings,
    queryFn: ({ signal }) => api.get(R.settings, SettingsSchema, signal),
  });
/** `instance.plan` defaults to Free, for a server older than #279. */
export const LenientMeSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null) return raw;
  const { instance } = raw as { instance?: unknown };
  if (typeof instance !== "object" || instance === null) return raw;
  return { ...raw, instance: { plan: "free", ...instance } };
}, MeSchema);
/** Keeps only the metrics this build knows, so one new server metric never blanks the page;
    `plan` defaults to Free, for a server older than #279. */
const LenientUsageSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null) return raw;
  const { metrics } = raw as { metrics?: unknown };
  if (!Array.isArray(metrics)) return raw;
  const known = UsageSchema.shape.metrics.element;
  return {
    plan: "free",
    ...raw,
    metrics: metrics.filter((m) => known.safeParse(m).success),
  };
}, UsageSchema);
export const useUsage = (
  opts: { enabled?: boolean; staleTime?: number } = {},
) =>
  useQuery({
    queryKey: qk.usage,
    queryFn: ({ signal }) => api.get(R.usage, LenientUsageSchema, signal),
    ...opts,
  });

/** Run `fn` then invalidate every key `keys()` returns. */
const useInvalidating = <V, T>(
  fn: (v: V) => Promise<T>,
  keys: () => (readonly unknown[])[],
  failure?: string,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    // Here, not at the call site: the row (and its component) may be gone by now.
    ...(failure
      ? {
          onError: (e: unknown) =>
            toast({
              title: failure,
              ...(e instanceof ApiClientError
                ? { description: e.message }
                : {}),
              tone: "danger",
            }),
        }
      : {}),
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
export const useRestoreVersion = (id: string) =>
  useInvalidating(
    (v: number) =>
      api.send("POST", R.restoreVersion(id, v), undefined, PublishResultSchema),
    () => [...artifactKeys(id)(), qk.versions(id)],
  );
export const usePatchArtifact = (id: string) =>
  useInvalidating(
    (patch: ArtifactPatch) =>
      api.send("PATCH", R.artifact(id), patch, ArtifactSummarySchema),
    artifactKeys(id),
  );
/** The caller navigates away, then drops `qk.artifact(id)` once its observers unmount. */
export const useDeleteArtifact = (id: string) =>
  useInvalidating(
    () => api.send("DELETE", R.artifact(id), undefined),
    () => [["artifacts"]],
  );
export const usePutShare = (id: string) =>
  useInvalidating(
    (input: ShareInput) =>
      api.send("PUT", R.shares(id), input, ShareResultSchema),
    () => [qk.shares(id)],
  );
export const useDeleteShare = (id: string) =>
  useInvalidating(
    (email: string) => api.send("DELETE", R.share(id, email), undefined),
    () => [qk.shares(id)],
  );

export const useInviteMember = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MemberInvite) =>
      api.send("POST", R.members, input, MemberInviteResultSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.members }),
    onError: (e) => failToast(e, "Couldn't send the invite."),
  });
};

/** Optimistic: `mutate` shows the new value at once; a failure restores the cached list. */
const useOptimisticMembers = <V>(
  fn: (v: V) => Promise<unknown>,
  apply: (list: Member[], v: V) => Member[],
  failure: string,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onMutate: async (v: V) => {
      await qc.cancelQueries({ queryKey: qk.members });
      const prev = qc.getQueryData<Member[]>(qk.members);
      if (prev) qc.setQueryData(qk.members, apply(prev, v));
      return { prev };
    },
    // Here, not at the call site: the row (and its component) may be gone by now.
    onError: (e, _v, ctx) => {
      failToast(e, failure);
      if (ctx?.prev) qc.setQueryData(qk.members, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.members }),
  });
};
export const usePatchMember = () =>
  useOptimisticMembers(
    (v: { id: string } & MemberPatch) =>
      api.send("PATCH", R.member(v.id), { role: v.role }, MemberSchema),
    (list, v) => list.map((m) => (m.id === v.id ? { ...m, role: v.role } : m)),
    "Couldn't change the role.",
  );
export const useRemoveMember = () =>
  useOptimisticMembers(
    (id: string) => api.send("DELETE", R.member(id), undefined),
    (list, id) => list.filter((m) => m.id !== id),
    "Couldn't remove the member.",
  );

/** PATCH /me; the response is the new Me, so it replaces the cache. Errors are the caller's to show. */
export const useUpdateMe = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: MePatch) =>
      api.send("PATCH", R.me, patch, LenientMeSchema),
    onSuccess: (me) => qc.setQueryData(qk.me, me),
  });
};

export const useUpdateSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) =>
      api.send("PATCH", R.settings, patch, SettingsSchema),
    onError: (e: unknown) => failToast(e, "Couldn't save settings"),
    // Refetch rather than trust the response: untouched fields resync too.
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.settings }),
        qc.invalidateQueries({ queryKey: qk.me }), // the sidebar shows the name
      ]),
  });
};
