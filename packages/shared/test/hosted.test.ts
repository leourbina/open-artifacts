import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiErrorSchema,
  ArtifactSummarySchema,
  AUTH,
  AuditEventSchema,
  AuthProvidersSchema,
  artifactCan,
  CodeRateLimitedDetailsSchema,
  CodeRequestedSchema,
  CodeRequestSchema,
  CodeVerifiedSchema,
  CodeVerifyFailureDetailsSchema,
  DirectoryGroupSchema,
  ERROR_CODES,
  GroupMappingSchema,
  HealthzSchema,
  HostedListQuerySchema,
  HostedPublishInputSchema,
  MemberSchema,
  MembersQuerySchema,
  MeSchema,
  normalizeCode,
  PageSchema,
  PublishInputSchema,
  parseFeatures,
  R,
  RestrictedGroupSchema,
  SearchHitSchema,
  SpaceMemberSchema,
  SpacePatchSchema,
  SpaceSchema,
  STATUS_FOR,
  SyncStatusSchema,
  TEST_HOOKS_ALLOWED,
  TestSessionInputSchema,
  TransferInputSchema,
  TransferResultSchema,
  TransferSummarySchema,
} from "../src/index.js";
import { fixtures } from "../src/mocks/fixtures.js";
import { createHandlers } from "../src/mocks/handlers.js";
import { HOSTED_MOCK_CODE } from "../src/mocks/hosted.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const fresh = (o?: Parameters<typeof createHandlers>[0]) =>
  server.use(...createHandlers(o));

const O = "http://localhost";
const H: Record<string, string> = {
  "content-type": "application/json",
  "x-oa-request": "1",
  cookie: "s=1",
};
const call = (method: string, path: string, body?: unknown, headers = H) =>
  fetch(`${O}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;
const errCode = async (r: Response) =>
  ApiErrorSchema.parse(await r.json()).error;

/** Response schemas made strict: an unexpected key fails the mock tests. */
const Strict = {
  Me: MeSchema.strict(),
  ArtifactSummary: ArtifactSummarySchema.strict(),
  SearchHit: SearchHitSchema.strict(),
  Space: SpaceSchema.strict(),
  SpaceMember: SpaceMemberSchema.strict(),
  GroupMapping: GroupMappingSchema.strict(),
  SyncStatus: SyncStatusSchema.strict(),
  TransferSummary: TransferSummarySchema.strict(),
  TransferResult: TransferResultSchema.strict(),
  CodeVerified: CodeVerifiedSchema.strict(),
  CodeRequested: CodeRequestedSchema.strict(),
  AuthProviders: AuthProvidersSchema.strict(),
  Member: MemberSchema.strict(),
  RestrictedGroup: RestrictedGroupSchema.strict(),
  DirectoryGroup: DirectoryGroupSchema.strict(),
  AuditEvent: AuditEventSchema.strict(),
};

describe("hosted contract schemas", () => {
  it("every new error code has a status", () => {
    expect(Object.keys(STATUS_FOR).sort()).toEqual([...ERROR_CODES].sort());
    expect(STATUS_FOR.space_forbidden).toBe(403);
    expect(STATUS_FOR.turnstile_required).toBe(400);
    expect(STATUS_FOR.directory_sync_off).toBe(409);
  });

  it("old shapes still parse; new fields are optional", () => {
    expect(MeSchema.parse(fixtures.me)).toEqual(fixtures.me);
    for (const a of fixtures.artifacts)
      expect(ArtifactSummarySchema.parse(a)).toEqual(a);
    for (const m of fixtures.members) expect(MemberSchema.parse(m)).toEqual(m);
    expect(
      HealthzSchema.parse({ ok: true, plan: "free", version: "1" }),
    ).toBeTruthy();
  });

  it("round-trips the hosted shapes", () => {
    const providers = {
      mode: "direct",
      providers: [
        { id: "google", start: AUTH.loginGoogle, domains: ["acme.com"] },
        {
          id: "email",
          domainCodes: false,
          guests: true,
          turnstileSiteKey: "k",
        },
      ],
    };
    expect(AuthProvidersSchema.parse(providers)).toEqual(providers);
    expect(
      CodeRequestSchema.parse({ email: " b@acme.com ", turnstileToken: "t" }),
    ).toEqual({ email: "b@acme.com", turnstileToken: "t" });
    expect(CodeRequestSchema.safeParse({ email: "nope" }).success).toBe(false);
    expect(normalizeCode(" 1234-5678\t")).toBe("12345678");
    expect(
      CodeVerifyFailureDetailsSchema.parse({
        reason: "invalid_code",
        attemptsLeft: 3,
      }),
    ).toEqual({ reason: "invalid_code", attemptsLeft: 3 });
    expect(
      CodeRateLimitedDetailsSchema.parse({ retryAfter: 60, scope: "ip" }),
    ).toEqual({ retryAfter: 60, scope: "ip" });
    expect(SpacePatchSchema.safeParse({ kind: "shared" }).success).toBe(false);
    expect(
      TransferInputSchema.parse({
        to: { kind: "space", spaceId: "s" },
        cursor: "c",
      }),
    ).toEqual({ to: { kind: "space", spaceId: "s" }, cursor: "c" });
    expect(
      MembersQuerySchema.parse({ status: "suspended,removed" }).status,
    ).toEqual(["suspended", "removed"]);
    expect(MembersQuerySchema.parse({}).status).toEqual(["active"]);
    expect(MembersQuerySchema.safeParse({ status: "gone" }).success).toBe(
      false,
    );
    expect(HostedListQuerySchema.safeParse({ scope: "space" }).success).toBe(
      false,
    );
    expect(
      HostedListQuerySchema.parse({ scope: "space", spaceId: "s" }).spaceId,
    ).toBe("s");
    expect(
      TestSessionInputSchema.parse({
        email: "a@b.co",
        role: "member",
        spaces: [{ spaceId: "s", role: "editor" }],
      }).spaces,
    ).toHaveLength(1);
    expect(parseFeatures("guests_read_only,spaces")).toEqual(["spaces"]);
    expect(parseFeatures("spaces, usage_off,bogus,spaces")).toEqual([
      "spaces",
      "usage_off",
    ]);
    expect(TEST_HOOKS_ALLOWED).toBe(false);
  });

  it("publish: spaceId is hosted-only and keeps the publish rules", () => {
    const base = { title: "t", format: "html", content: "x" };
    expect(
      PublishInputSchema.safeParse({ ...base, spaceId: "s" }).success,
    ).toBe(false);
    expect(
      HostedPublishInputSchema.parse({ ...base, spaceId: "s" }),
    ).toMatchObject({
      spaceId: "s",
      title: "t",
    });
    expect(HostedPublishInputSchema.safeParse({ spaceId: "s" }).success).toBe(
      false,
    );
  });

  it("artifactCan follows the action table", () => {
    expect(artifactCan("viewer", { personal: false })).toEqual({
      edit: false,
      share: false,
      setVisibility: false,
      delete: false,
      transfer: false,
      move: false,
      dataWrite: true,
    });
    expect(artifactCan("manager", { personal: false }).transfer).toBe(false);
    expect(artifactCan("manager", { personal: false }).move).toBe(true);
    expect(artifactCan("owner", { personal: true }).transfer).toBe(true);
    expect(artifactCan("owner", { personal: true, cap: "guest" })).toEqual({
      edit: false,
      share: false,
      setVisibility: false,
      delete: false,
      transfer: false,
      move: false,
      dataWrite: false,
    });
    expect(
      artifactCan("viewer", { personal: false, cap: "restricted" }).dataWrite,
    ).toBe(false);
  });
});

describe("hosted off: responses are byte-identical", () => {
  it("me, list, members, search carry no hosted fields", async () => {
    fresh();
    expect(await (await call("GET", R.me)).text()).toBe(
      JSON.stringify(fixtures.me),
    );
    expect(await (await call("GET", R.members)).text()).toBe(
      JSON.stringify(fixtures.members),
    );
    const list = await (await call("GET", `${R.artifacts}?limit=100`)).text();
    expect(list).toBe(
      JSON.stringify({ items: fixtures.artifacts, nextCursor: null }),
    );
    for (const k of ['"space"', '"can"', '"status"', '"hosted"', '"auth"'])
      expect(list).not.toContain(k);
  });
});

describe("hosted mocks", () => {
  it("providers -> code request -> verify -> me with spaces -> list with can/space -> move refusal", async () => {
    fresh({ hosted: true });
    const p = Strict.AuthProviders.parse(
      await json(await call("GET", AUTH.providers)),
    );
    expect(p.mode).toBe("direct");
    expect(p.providers.map((x) => x.id)).toEqual(["google", "email"]);

    const rq = await call("POST", AUTH.codeRequest, {
      email: "Ada@example.com",
      next: "/a/x",
    });
    expect(rq.status).toBe(202);
    expect(Strict.CodeRequested.parse(await rq.json())).toEqual({
      maskedEmail: "a***@example.com",
      expiresIn: 600,
      resendAfter: 60,
      codeLength: 8,
    });
    const bad = await call("POST", AUTH.codeVerify, { code: "0000 0000" });
    expect(bad.status).toBe(401);
    expect((await errCode(bad)).details).toEqual({
      reason: "invalid_code",
      attemptsLeft: 4,
    });
    const ok = await call("POST", AUTH.codeVerify, {
      code: `${HOSTED_MOCK_CODE.slice(0, 4)} ${HOSTED_MOCK_CODE.slice(4)}`,
    });
    expect(ok.status).toBe(200);
    const v = Strict.CodeVerified.parse(await ok.json());
    expect(v).toMatchObject({ next: "/a/x", readOnly: false });
    expect(v.user.email).toBe("ada@example.com");

    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.instance.hosted).toBe(true);
    expect(me.instance.tier).toBe("business");
    expect(me.instance.features).toContain("usage_off");
    expect(me.instance.directory).toMatchObject({
      mode: "google",
      healthy: true,
      banner: false,
    });
    expect(me.auth).toMatchObject({
      method: "code",
      readOnly: false,
      cap: null,
    });
    expect(me.personalSpaceId).toBe(me.user.id);
    expect(me.spaces?.map((s) => [s.name, s.myRole])).toEqual([
      ["Engineering", "manager"],
      ["Exec", "viewer"],
    ]);

    const list = PageSchema(Strict.ArtifactSummary).parse(
      await json(await call("GET", `${R.artifacts}?limit=100`)),
    );
    const notes = list.items.find((a) => a.title === "Meeting notes");
    expect(notes?.access).toBe("manager");
    expect(notes?.space).toMatchObject({ kind: "shared", name: "Engineering" });
    expect(notes?.can).toMatchObject({ move: true, transfer: false });
    const mine = list.items.find((a) => a.title === "Landing page");
    expect(mine?.space).toMatchObject({ kind: "personal", id: me.user.id });
    expect(mine?.can?.transfer).toBe(true);
    const viewer = list.items.find((a) => a.access === "viewer");
    expect(viewer?.can).toMatchObject({ edit: false, dataWrite: true });
    const hits = PageSchema(Strict.SearchHit).parse(
      await json(await call("GET", `${R.search}?q=notes`)),
    );
    expect(hits.items[0]?.space?.name).toBe("Engineering");

    // Move: a personal target is refused; a viewer-role space is forbidden; Engineering works.
    const bob = fixtures.members[1]?.id as string;
    const toPersonal = await call("POST", R.moveArtifact(mine?.id as string), {
      spaceId: bob,
    });
    expect(toPersonal.status).toBe(400);
    expect((await errCode(toPersonal)).code).toBe("space_personal");
    const exec = me.spaces?.find((s) => s.name === "Exec")?.id as string;
    const forbidden = await call("POST", R.moveArtifact(mine?.id as string), {
      spaceId: exec,
    });
    expect(forbidden.status).toBe(403);
    expect((await errCode(forbidden)).code).toBe("space_forbidden");
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    const moved = Strict.ArtifactSummary.parse(
      await json(
        await call("POST", R.moveArtifact(mine?.id as string), {
          spaceId: eng,
        }),
      ),
    );
    expect(moved).toMatchObject({ access: "manager", space: { id: eng } });
  });

  it("code flow: no_pending, expiry after 5 tries, turnstile, rate limits", async () => {
    fresh({ hosted: { turnstile: true } });
    const none = await call("POST", AUTH.codeVerify, { code: "1" });
    expect((await errCode(none)).details).toEqual({ reason: "no_pending" });
    const missing = await call("POST", AUTH.codeRequest, {
      email: "x@example.com",
    });
    expect(missing.status).toBe(400);
    expect(await errCode(missing)).toMatchObject({
      code: "turnstile_required",
      details: { field: "turnstile", required: true },
    });
    const rejected = await call("POST", AUTH.codeRequest, {
      email: "x@example.com",
      turnstileToken: "fail",
    });
    expect((await errCode(rejected)).code).toBe("turnstile_failed");
    const req = { email: "g@outside.org", turnstileToken: "ok" };
    expect((await call("POST", AUTH.codeRequest, req)).status).toBe(202);
    for (let i = 0; i < 4; i++)
      await call("POST", AUTH.codeVerify, { code: "11111111" });
    const dead = await call("POST", AUTH.codeVerify, { code: "11111111" });
    expect((await errCode(dead)).details).toEqual({ reason: "expired" });
    for (let i = 0; i < 4; i++) await call("POST", AUTH.codeRequest, req);
    const limited = await call("POST", AUTH.codeRequest, req);
    expect(limited.status).toBe(429);
    expect(
      CodeRateLimitedDetailsSchema.parse((await errCode(limited)).details)
        .scope,
    ).toBe("email");
  });

  it("guest sign-in is read-only and can't publish", async () => {
    fresh({ hosted: true });
    await call("POST", AUTH.codeRequest, { email: "guest@outside.org" });
    const v = Strict.CodeVerified.parse(
      await json(
        await call("POST", AUTH.codeVerify, { code: HOSTED_MOCK_CODE }),
      ),
    );
    expect(v.user.role).toBe("guest");
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.auth).toMatchObject({ readOnly: true, cap: "guest" });
    const list = await json(await call("GET", R.artifacts));
    expect(list.items[0].can.dataWrite).toBe(false);
    const pub = await call("POST", R.artifacts, {
      title: "t",
      format: "html",
      content: "x",
    });
    expect((await errCode(pub)).code).toBe("space_forbidden");
  });

  it("spaces, members, mappings, directory, transfer", async () => {
    fresh({ hosted: true });
    const spaces = PageSchema(Strict.Space).parse(
      await json(await call("GET", R.spaces)),
    );
    expect(spaces.items[0]?.kind).toBe("personal");
    const clients = spaces.items.find((s) => s.name === "Clients");
    expect(clients?.myRole).toBeNull();
    const created = Strict.Space.parse(
      await json(await call("POST", R.spaces, { name: "Sales" })),
    );
    expect(created).toMatchObject({
      kind: "shared",
      publicLinks: true,
      myRole: null,
    });
    const bob = fixtures.members[1]?.id as string;
    const m = Strict.SpaceMember.parse(
      await json(
        await call("PUT", R.spaceMember(created.id, bob), { role: "editor" }),
      ),
    );
    expect(m).toMatchObject({ userId: bob, role: "editor", source: "manual" });
    expect(
      Strict.GroupMapping.parse(
        await json(
          await call("PUT", R.spaceMapping(created.id, "gSales03"), {
            role: "viewer",
          }),
        ),
      ).name,
    ).toBe("Sales");
    const patched = Strict.Space.parse(
      await json(
        await call("PATCH", R.space(created.id), { publicLinks: false }),
      ),
    );
    expect(patched.publicLinks).toBe(false);
    expect((await call("DELETE", R.space(created.id))).status).toBe(204);
    const personal = await call(
      "PATCH",
      R.space(fixtures.members[0]?.id as string),
      { name: "x" },
    );
    expect((await errCode(personal)).code).toBe("space_personal");

    const st = Strict.SyncStatus.parse(
      await json(await call("GET", R.directory)),
    );
    expect(st).toMatchObject({
      mode: "google",
      healthy: true,
      customerMismatch: null,
    });
    expect(st.held).toHaveLength(1);
    expect(
      (await call("POST", R.directoryHeldConfirm("gSales03"))).status,
    ).toBe(202);
    expect((await call("POST", R.directorySync)).status).toBe(202);

    const departed = await json(
      await call("GET", `${R.members}?status=suspended,removed`),
    );
    expect(departed.map((x: { status: string }) => x.status)).toEqual([
      "suspended",
    ]);
    const carol = departed[0].id as string;
    expect(
      Strict.TransferSummary.parse(
        await json(await call("GET", R.memberTransfer(carol))),
      ),
    ).toEqual({
      live: 2,
      deleted: 1,
    });
    const toPersonal = await call("POST", R.memberTransfer(carol), {
      to: { kind: "space", spaceId: bob },
    });
    expect((await errCode(toPersonal)).code).toBe("space_personal");
    const toCarol = await call("POST", R.memberTransfer(carol), {
      to: { kind: "user", userId: carol },
    });
    expect((await errCode(toCarol)).code).toBe("invalid_successor");
    expect(
      Strict.TransferResult.parse(
        await json(
          await call("POST", R.memberTransfer(carol), {
            to: { kind: "user", userId: bob },
          }),
        ),
      ),
    ).toEqual({ moved: 3, remaining: 0, nextCursor: null });
    const active = await call("POST", R.memberTransfer(bob), {
      to: { kind: "user", userId: bob },
    });
    expect((await errCode(active)).code).toBe("member_active");
    expect((await call("GET", R.usage)).status).toBe(404);
  });

  it("frozen sync refuses mapping changes; unhealthy shows the banner", async () => {
    fresh({ hosted: { directory: "frozen", unhealthy: true } });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.instance.directory).toMatchObject({
      mode: "frozen",
      healthy: false,
      banner: true,
      tokensUnverified: true,
    });
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    const r = await call("PUT", R.spaceMapping(eng, "x@example.com"), {
      role: "viewer",
    });
    expect(r.status).toBe(409);
    expect((await errCode(r)).code).toBe("directory_sync_off");
  });

  it("transfer of a personal artifact and spaceId on publish", async () => {
    fresh({ hosted: true });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    const exec = me.spaces?.find((s) => s.name === "Exec")?.id as string;
    const base = { title: "n", format: "html", content: "x" };
    expect(
      (await call("POST", R.artifacts, { ...base, spaceId: eng })).status,
    ).toBe(201);
    const forbidden = await call("POST", R.artifacts, {
      ...base,
      spaceId: exec,
    });
    expect((await errCode(forbidden)).code).toBe("space_forbidden");
    const id = fixtures.artifacts[0]?.id as string;
    const useMove = await call("POST", R.artifacts, {
      ...base,
      id,
      spaceId: eng,
    });
    expect((await errCode(useMove)).code).toBe("use_move");
    const bob = fixtures.members[1]?.id as string;
    const t = Strict.ArtifactSummary.parse(
      await json(await call("POST", R.transferArtifact(id), { userId: bob })),
    );
    expect(t).toMatchObject({
      access: "editor",
      space: { id: bob },
      owner: { id: bob },
    });
    expect(
      z.array(Strict.Member).parse(await json(await call("GET", R.members)))[0]
        ?.status,
    ).toBe("active");
  });
});

describe("hosted mocks: restriction, public links, admin self-add, audit", () => {
  const signIn = async (email: string) => {
    await call("POST", AUTH.codeRequest, { email });
    return Strict.CodeVerified.parse(
      await json(
        await call("POST", AUTH.codeVerify, { code: HOSTED_MOCK_CODE }),
      ),
    );
  };

  it("a restricted-group member is capped and gets no allMembersRole", async () => {
    fresh({ hosted: true });
    const v = await signIn("dan@example.com");
    expect(v.readOnly).toBe(true);
    expect(v.user.restriction?.groups.map((g) => g.groupId)).toEqual([
      "gCon04",
    ]);
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.auth).toMatchObject({ readOnly: true, cap: "restricted" });
    // Engineering has allMembersRole viewer, which never reaches Dan.
    expect(me.spaces).toEqual([]);
    const pub = await call("POST", R.artifacts, {
      title: "t",
      format: "html",
      content: "x",
    });
    expect((await errCode(pub)).code).toBe("space_forbidden");
  });

  it("manual restricted flag: cap on space members, no successor, audited", async () => {
    fresh({ hosted: { directory: "frozen" } });
    const bob = fixtures.members[1]?.id as string;
    const set = Strict.Member.parse(
      await json(await call("PUT", R.memberRestricted(bob))),
    );
    expect(set.restriction).toEqual({ manual: true, groups: [] });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    const ms = PageSchema(Strict.SpaceMember).parse(
      await json(await call("GET", R.spaceMembers(eng))),
    );
    expect(ms.items.find((m) => m.userId === bob)?.cap).toBe("restricted");
    const id = fixtures.artifacts[0]?.id as string;
    const t = await call("POST", R.transferArtifact(id), { userId: bob });
    expect((await errCode(t)).code).toBe("invalid_successor");
    const cleared = Strict.Member.parse(
      await json(await call("DELETE", R.memberRestricted(bob))),
    );
    expect(cleared.restriction).toBeNull();
    const audit = PageSchema(Strict.AuditEvent).parse(
      await json(await call("GET", R.audit)),
    );
    expect(audit.items.map((e) => e.action)).toEqual([
      "restricted.remove",
      "restricted.set",
    ]);
  });

  it("restricted groups by groupId: PUT 409 when frozen, DELETE allowed", async () => {
    fresh({ hosted: { directory: "frozen" } });
    const list = z
      .array(Strict.RestrictedGroup)
      .parse(await json(await call("GET", R.restrictedGroups)));
    expect(list.map((g) => g.groupId)).toEqual(["gCon04"]);
    const put = await call("PUT", R.restrictedGroup("gSales03"));
    expect((await errCode(put)).code).toBe("directory_sync_off");
    expect((await call("DELETE", R.restrictedGroup("gCon04"))).status).toBe(
      204,
    );
  });

  it("restricted groups and the group picker with sync on", async () => {
    fresh({ hosted: true });
    const g = Strict.RestrictedGroup.parse(
      await json(await call("PUT", R.restrictedGroup("gSales03"))),
    );
    expect(g).toMatchObject({
      groupId: "gSales03",
      email: "sales@example.com",
    });
    expect((await call("PUT", R.restrictedGroup("nope"))).status).toBe(404);
    const picker = PageSchema(Strict.DirectoryGroup).parse(
      await json(await call("GET", `${R.directoryGroups}?q=eng`)),
    );
    expect(picker.items.map((x) => x.groupId)).toEqual(["gEng01"]);
  });

  it("public in a space with publicLinks off is 403 public_links_off", async () => {
    fresh({ hosted: true });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.spaces?.find((s) => s.name === "Exec")?.publicLinks).toBe(false);
    // The caller manages Engineering ("Meeting notes"); turn its public links off.
    const eng = me.spaces?.find((s) => s.name === "Engineering")?.id as string;
    expect(
      (await call("PATCH", R.space(eng), { publicLinks: false })).status,
    ).toBe(200);
    const notes = fixtures.artifacts.find((a) => a.title === "Meeting notes")
      ?.id as string;
    const r = await call("PATCH", R.artifact(notes), { visibility: "public" });
    expect(r.status).toBe(403);
    expect((await errCode(r)).code).toBe("public_links_off");
    const create = await call("POST", R.artifacts, {
      title: "t",
      format: "html",
      content: "x",
      spaceId: eng,
      visibility: "public",
    });
    expect((await errCode(create)).code).toBe("public_links_off");
  });

  it("admin self-add to a shared space only, audited", async () => {
    fresh({ hosted: true });
    const spaces = PageSchema(Strict.Space).parse(
      await json(await call("GET", R.spaces)),
    );
    const clients = spaces.items.find((s) => s.name === "Clients")
      ?.id as string;
    const r = await call("POST", R.spaceMemberSelf(clients), {
      role: "viewer",
    });
    expect(r.status).toBe(201);
    expect(Strict.SpaceMember.parse(await r.json())).toMatchObject({
      role: "viewer",
    });
    const personal = await call(
      "POST",
      R.spaceMemberSelf(fixtures.members[0]?.id as string),
      { role: "viewer" },
    );
    expect((await errCode(personal)).code).toBe("space_personal");
    const audit = PageSchema(Strict.AuditEvent).parse(
      await json(await call("GET", R.audit)),
    );
    expect(audit.items[0]).toMatchObject({
      action: "space.admin_self_add",
      spaceId: clients,
    });
  });

  it("guests_read_only is reported from sign-in config, never from FEATURES", async () => {
    fresh({ hosted: { mode: "access", features: ["guests_read_only"] } });
    const me = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me.instance.features).not.toContain("guests_read_only");
    server.resetHandlers();
    fresh({ hosted: true });
    const me2 = Strict.Me.parse(await json(await call("GET", R.me)));
    expect(me2.instance.features).toContain("guests_read_only");
  });
});
