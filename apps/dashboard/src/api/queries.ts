import {
  type ArtifactPatch,
  ArtifactSummarySchema,
  type ListQueryInput,
  ListQuerySchema,
  type Me,
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
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "../layout/toast";
import { ApiClientError, api } from "./client";
import {
  DirectoryGroupSchema,
  GroupMappingSchema,
  RestrictedGroupSchema,
  type SpaceCreateInput,
  SpaceMemberSchema,
  type SpacePatchInput,
  type SpaceRole,
  SpaceSchema,
  type SpacesQuerySchema,
  SyncStatusSchema,
  type TransferInput,
  TransferResultSchema,
  TransferSummarySchema,
} from "./contract";
import {
  DIRECTORY_SETTINGS,
  type ErrorContext,
  errorCopy,
  errorLink,
} from "./errorCopy";

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
  /** Every member query: the lists below and per-member data. */
  members: ["members"] as const,
  memberList: (status?: string) => ["members", status ?? "active"] as const,
  memberTransfer: (id: string) => ["members", id, "transfer"] as const,
  tokens: ["tokens"] as const,
  oauthClients: ["oauth-clients"] as const,
  settings: ["settings"] as const,
  usage: ["usage"] as const,
  spaces: (q?: SpacesQueryInput) => ["spaces", q ?? {}] as const,
  space: (id: string) => ["spaces", id] as const,
  spaceMembers: (id: string) => ["spaces", id, "members"] as const,
  spaceMappings: (id: string) => ["spaces", id, "mappings"] as const,
  directory: ["directory"] as const,
  restrictedGroups: ["directory", "restricted"] as const,
  directoryGroups: (q: string) => ["directory", "groups", q] as const,
};

type SpacesQueryInput = z.input<typeof SpacesQuerySchema>;

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
/** Active members by default; `status` (a comma list) is hosted, so the default sends none. */
export const useMembers = (status?: string) =>
  useQuery({
    queryKey: qk.memberList(status),
    queryFn: ({ signal }) =>
      api.get(withQuery(R.members, { status }), z.array(MemberSchema), signal),
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
/** Keeps only the metrics this build knows, so one new server metric never blanks the page. */
const LenientUsageSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null) return raw;
  const { metrics } = raw as { metrics?: unknown };
  if (!Array.isArray(metrics)) return raw;
  const known = UsageSchema.shape.metrics.element;
  return {
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

/** Where the error shows and who hit it, for `errorCopy` and `errorLink`. */
const errorContext = (qc: QueryClient): ErrorContext => ({
  capped: qc.getQueryData<Me>(qk.me)?.auth?.cap != null,
  onDirectoryPage: location.pathname.startsWith(DIRECTORY_SETTINGS),
});

/** A failure toast: `title`, Design's copy for `e`, and its link if any. */
const failureToast = (
  qc: QueryClient,
  title: string,
  e: unknown,
  fallback = "",
) => {
  const ctx = errorContext(qc);
  const description = errorCopy(e, fallback, ctx);
  const link = errorLink(e, ctx);
  toast({
    title,
    ...(description ? { description } : {}),
    tone: "danger",
    // Hooks sit outside the router, so the link is a page load.
    ...(link
      ? {
          action: {
            label: link.label,
            onClick: () => location.assign(link.to),
          },
        }
      : {}),
  });
};

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
          onError: (e: unknown) => failureToast(qc, failure, e),
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
      // Every cached list (one per status filter), not per-member data.
      const prev = qc.getQueriesData<Member[]>({
        queryKey: qk.members,
        predicate: (q) => Array.isArray(q.state.data),
      });
      for (const [key, list] of prev)
        if (list) qc.setQueryData(key, apply(list, v));
      return { prev };
    },
    // Here, not at the call site: the row (and its component) may be gone by now.
    onError: (e, _v, ctx) => {
      failToast(e, failure);
      for (const [key, list] of ctx?.prev ?? []) qc.setQueryData(key, list);
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
    mutationFn: (patch: MePatch) => api.send("PATCH", R.me, patch, MeSchema),
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

// Hosted M1 (packages/shared/HOSTED_CONTRACT.md). Only hosted pages call these.

const SpacePage = PageSchema(SpaceSchema);
const SpaceMemberPage = PageSchema(SpaceMemberSchema);
const DirectoryGroupPage = PageSchema(DirectoryGroupSchema);

export const useSpaces = (q?: SpacesQueryInput, enabled = true) =>
  useInfiniteQuery({
    enabled,
    queryKey: qk.spaces(q),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get(
        withQuery(R.spaces, { ...q, cursor: pageParam }),
        SpacePage,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
export const useSpace = (id: string, enabled = true) =>
  useQuery({
    enabled,
    queryKey: qk.space(id),
    queryFn: ({ signal }) => api.get(R.space(id), SpaceSchema, signal),
  });
/** Me.spaces lists the caller's spaces, so space changes refresh /me too. */
export const useCreateSpace = () =>
  useInvalidating(
    (input: SpaceCreateInput) => api.send("POST", R.spaces, input, SpaceSchema),
    () => [["spaces"], qk.me],
    "Couldn't create the space.",
  );
/** Turning public links off rewrites public artifacts to team, so the library refreshes. */
export const usePatchSpace = (id: string) =>
  useInvalidating(
    (patch: SpacePatchInput) =>
      api.send("PATCH", R.space(id), patch, SpaceSchema),
    () => [["spaces"], qk.me, ["artifacts"]],
    "Couldn't save the space.",
  );
export const useDeleteSpace = () =>
  useInvalidating(
    (id: string) => api.send("DELETE", R.space(id), undefined),
    () => [["spaces"], qk.me],
    "Couldn't delete the space.",
  );
export const useSpaceMembers = (id: string) =>
  useInfiniteQuery({
    queryKey: qk.spaceMembers(id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get(
        withQuery(R.spaceMembers(id), { cursor: pageParam }),
        SpaceMemberPage,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
const spaceMemberKeys = (id: string) => () => [
  qk.spaceMembers(id),
  qk.space(id),
];
export const usePutSpaceMember = (id: string) =>
  useInvalidating(
    (v: { userId: string; role: SpaceRole }) =>
      api.send(
        "PUT",
        R.spaceMember(id, v.userId),
        { role: v.role },
        SpaceMemberSchema,
      ),
    spaceMemberKeys(id),
    "Couldn't change access.",
  );
export const useDeleteSpaceMember = (id: string) =>
  useInvalidating(
    (userId: string) =>
      api.send("DELETE", R.spaceMember(id, userId), undefined),
    spaceMemberKeys(id),
    "Couldn't change access.",
  );
/** An org admin adds themselves to a shared space (audited; managers are notified). */
export const useAddSelfToSpace = (id: string) =>
  useInvalidating(
    (v: { role: SpaceRole }) =>
      api.send("POST", R.spaceMemberSelf(id), v, SpaceMemberSchema),
    () => [...spaceMemberKeys(id)(), ["spaces"], qk.me],
    "Couldn't change access.",
  );
export const useSpaceMappings = (id: string) =>
  useQuery({
    queryKey: qk.spaceMappings(id),
    queryFn: ({ signal }) =>
      api.get(R.spaceMappings(id), z.array(GroupMappingSchema), signal),
  });
const mappingKeys = (id: string) => () => [
  qk.spaceMappings(id),
  qk.spaceMembers(id),
];
export const usePutMapping = (id: string) =>
  useInvalidating(
    (v: { groupId: string; role: SpaceRole }) =>
      api.send(
        "PUT",
        R.spaceMapping(id, v.groupId),
        { role: v.role },
        GroupMappingSchema,
      ),
    mappingKeys(id),
    "Couldn't change access.",
  );
export const useDeleteMapping = (id: string) =>
  useInvalidating(
    (groupId: string) =>
      api.send("DELETE", R.spaceMapping(id, groupId), undefined),
    mappingKeys(id),
    "Couldn't change access.",
  );
export const useRestrictedGroups = () =>
  useQuery({
    queryKey: qk.restrictedGroups,
    queryFn: ({ signal }) =>
      api.get(R.restrictedGroups, z.array(RestrictedGroupSchema), signal),
  });
const restrictedKeys = () => [qk.restrictedGroups, qk.members];
export const usePutRestrictedGroup = () =>
  useInvalidating(
    (groupId: string) =>
      api.send(
        "PUT",
        R.restrictedGroup(groupId),
        undefined,
        RestrictedGroupSchema,
      ),
    restrictedKeys,
    "Couldn't change the restriction.",
  );
export const useDeleteRestrictedGroup = () =>
  useInvalidating(
    (groupId: string) =>
      api.send("DELETE", R.restrictedGroup(groupId), undefined),
    restrictedKeys,
    "Couldn't change the restriction.",
  );
/** The MANUAL restricted flag only; a group restriction is lifted on Directory. */
export const useSetRestricted = () =>
  useInvalidating(
    (v: { memberId: string; restricted: boolean }) =>
      api.send(
        v.restricted ? "PUT" : "DELETE",
        R.memberRestricted(v.memberId),
        undefined,
        MemberSchema,
      ),
    () => [qk.members],
    "Couldn't change the restriction.",
  );
export const useDirectory = (enabled = true) =>
  useQuery({
    enabled,
    queryKey: qk.directory,
    queryFn: ({ signal }) => api.get(R.directory, SyncStatusSchema, signal),
  });
/** The group picker: searches from 2 characters. */
export const useDirectoryGroups = (q: string) =>
  useInfiniteQuery({
    enabled: q.trim().length >= 2,
    queryKey: qk.directoryGroups(q),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get(
        withQuery(R.directoryGroups, { q: q.trim(), cursor: pageParam }),
        DirectoryGroupPage,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
export const useDirectorySync = () =>
  useInvalidating(
    () => api.send("POST", R.directorySync, undefined, SyncStatusSchema),
    () => [qk.directory],
    "Couldn't start a sync.",
  );
export const useConfirmHeld = () =>
  useInvalidating(
    (groupId: string) =>
      api.send(
        "POST",
        R.directoryHeldConfirm(groupId),
        undefined,
        SyncStatusSchema,
      ),
    () => [qk.directory, qk.members],
    "Couldn't apply the change.",
  );
export const useDisconnectDirectory = () =>
  useInvalidating(
    () => api.send("DELETE", R.directory, undefined),
    () => [qk.directory, qk.me],
    "Couldn't disconnect.",
  );
/** Refreshes on failure too: a refused move may mean the page is stale. */
export const useMoveArtifact = (id: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spaceId: string) =>
      api.send("POST", R.moveArtifact(id), { spaceId }, ArtifactSummarySchema),
    onError: (e) =>
      failureToast(qc, "Couldn't move the artifact.", e, "Try again."),
    onSettled: () =>
      Promise.all(
        [qk.artifact(id), ["artifacts"], ["spaces"], ["search"]].map(
          (queryKey) => qc.invalidateQueries({ queryKey }),
        ),
      ),
  });
};
/** Counts only: never titles or artifact requests. */
export const useTransferSummary = (memberId: string) =>
  useQuery({
    queryKey: qk.memberTransfer(memberId),
    queryFn: ({ signal }) =>
      api.get(R.memberTransfer(memberId), TransferSummarySchema, signal),
  });
/** One page (≤ TRANSFER_PAGE) per call; the caller repeats with `nextCursor` until it is null. */
export const useRunTransfer = (memberId: string) =>
  useInvalidating(
    (input: TransferInput) =>
      api.send("POST", R.memberTransfer(memberId), input, TransferResultSchema),
    () => [qk.memberTransfer(memberId)],
    "Couldn't transfer the artifacts.",
  );
export const useResetIdentity = () =>
  useInvalidating(
    (memberId: string) =>
      api.send("DELETE", R.memberIdentity(memberId, "google"), undefined),
    () => [qk.members],
    "Couldn't reset the sign-in.",
  );
