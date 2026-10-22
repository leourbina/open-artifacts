import { env } from "cloudflare:workers";
import { normalizeEmail } from "@oa/auth-core";
import { newId, PublishResultSchema, R, viewerPath } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { getDb } from "../src/db/client.js";
import { shares } from "../src/db/schema.js";
import { publish } from "../src/services/artifacts.js";
import type { ManifestEntry } from "../src/services/manifest.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; userId: string };
let editor: { cookie: string; userId: string };
let viewer: { cookie: string; userId: string };

const version = (id: string, v: number) =>
  env.DB.prepare("select * from versions where artifact_id = ? and version = ?")
    .bind(id, v)
    .first<{
      manifest: string;
      entry: string;
      agent_name: string | null;
      created_by: string;
    }>();
const artifact = (id: string) =>
  env.DB.prepare("select * from artifacts where id = ?")
    .bind(id)
    .first<Record<string, unknown>>();

async function share(id: string, email: string, role: "viewer" | "editor") {
  await getDb(env)
    .insert(shares)
    .values({
      artifactId: id,
      email: normalizeEmail(email) ?? email,
      role,
      createdBy: owner.userId,
      createdAt: Date.now(),
    });
}

beforeAll(async () => {
  owner = await login(`pub-owner-${tag}@x.com`);
  editor = await login(`pub-editor-${tag}@x.com`);
  viewer = await login(`pub-viewer-${tag}@x.com`);
});

describe("publish", () => {
  let id: string;

  it("markdown content → version 1, bytes in R2", async () => {
    const r = await api(app, R.artifacts, owner.cookie, {
      method: "POST",
      body: { title: "Notes", format: "markdown", content: "# hi" },
    });
    expect(r.status).toBe(201);
    const res = PublishResultSchema.parse(await r.json());
    expect(res.version).toBe(1);
    expect(res.url).toBe(`http://app.localhost${viewerPath(res.id)}`);
    id = res.id;
    const v = await version(id, 1);
    const m = JSON.parse(v?.manifest ?? "[]") as ManifestEntry[];
    expect(v?.entry).toBe("README.md");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ path: "README.md", size: 4 });
    expect(m[0]?.key).toMatch(new RegExp(`^files/${id}/`));
    const obj = await env.FILES.get(m[0]?.key ?? "");
    expect(await obj?.text()).toBe("# hi");
    const a = await artifact(id);
    expect(a).toMatchObject({
      current_version: 1,
      format: "markdown",
      visibility: "private",
      title: "Notes",
      last_agent_name: null,
    });
  });

  it("second publish → version 2 with a new key", async () => {
    const r = await api(app, R.versions(id), owner.cookie, {
      method: "POST",
      body: {
        files: { "README.md": "# two", "img/a.bin": { base64: "AAEC" } },
      },
    });
    expect(r.status).toBe(201);
    expect((await r.json()) as { version: number }).toMatchObject({
      version: 2,
    });
    const m1 = JSON.parse(
      (await version(id, 1))?.manifest ?? "[]",
    ) as ManifestEntry[];
    const m2 = JSON.parse(
      (await version(id, 2))?.manifest ?? "[]",
    ) as ManifestEntry[];
    const readme = m2.find((e) => e.path === "README.md");
    expect(readme?.key).not.toBe(m1[0]?.key);
    expect(await (await env.FILES.get(readme?.key ?? ""))?.text()).toBe(
      "# two",
    );
    const bin = m2.find((e) => e.path === "img/a.bin");
    expect(bin?.size).toBe(3);
    const bytes = new Uint8Array(
      (await (await env.FILES.get(bin?.key ?? ""))?.arrayBuffer()) ??
        new ArrayBuffer(0),
    );
    expect([...bytes]).toEqual([0, 1, 2]);
    expect((await artifact(id))?.current_version).toBe(2);
  });

  it("records the passed AgentRef as lastAgent", async () => {
    const user = await getUser(env, owner.userId);
    if (!user) throw new Error("no user");
    const res = await publish(
      env,
      user,
      { id, content: "# agent", format: "markdown" },
      { name: "codex", version: "1.2.3" },
    );
    expect(res.version).toBe(3);
    expect(await artifact(id)).toMatchObject({
      last_agent_name: "codex",
      last_agent_version: "1.2.3",
    });
    expect((await version(id, 3))?.agent_name).toBe("codex");
  });

  it("REST publish with a PAT attributes the token label", async () => {
    const { token } = await createPat(env, owner.userId, "my-agent");
    const r = await api(app, R.versions(id), token, {
      method: "POST",
      body: { content: "# pat", format: "markdown" },
    });
    expect(r.status).toBe(201);
    expect(await artifact(id)).toMatchObject({
      last_agent_name: "my-agent",
      last_agent_version: null,
    });
  });

  it("an editor can publish; changing visibility → 400", async () => {
    await share(id, `pub-editor-${tag}@x.com`, "editor");
    const ok = await api(app, R.versions(id), editor.cookie, {
      method: "POST",
      body: { content: "# ed", format: "markdown" },
    });
    expect(ok.status).toBe(201);
    expect((await version(id, 5))?.created_by).toBe(editor.userId);
    const bad = await api(app, R.versions(id), editor.cookie, {
      method: "POST",
      body: { content: "# ed", format: "markdown", visibility: "public" },
    });
    expect(bad.status).toBe(400);
    expect((await errOf(bad)).code).toBe("bad_request");
    expect((await artifact(id))?.visibility).toBe("private");
  });

  it("a viewer publishing → 404", async () => {
    await share(id, `pub-viewer-${tag}@x.com`, "viewer");
    const r = await api(app, R.versions(id), viewer.cookie, {
      method: "POST",
      body: { content: "# v", format: "markdown" },
    });
    expect(r.status).toBe(404);
  });

  it("anonymous → 401; unknown artifact → 404", async () => {
    const anon = await api(app, R.artifacts, null, {
      method: "POST",
      body: { title: "x", format: "html", content: "<p>" },
    });
    expect(anon.status).toBe(401);
    const missing = await api(app, R.versions(newId()), owner.cookie, {
      method: "POST",
      body: { content: "# v", format: "markdown" },
    });
    expect(missing.status).toBe(404);
  });

  it("owner can change visibility and capabilities on update", async () => {
    const r = await api(app, R.versions(id), owner.cookie, {
      method: "POST",
      body: {
        content: "<p>x</p>",
        format: "html",
        visibility: "team",
        capabilities: { db: true },
      },
    });
    expect(r.status).toBe(201);
    const a = await artifact(id);
    expect(a?.visibility).toBe("team");
    expect(a?.format).toBe("html");
    expect(JSON.parse(String(a?.capabilities))).toEqual({
      db: true,
      viewer: false,
      storage: false,
    });
    expect((await version(id, Number(a?.current_version)))?.entry).toBe(
      "index.html",
    );
  });

  it("code content defaults entry to main.<ext>", async () => {
    const r = await api(app, R.artifacts, owner.cookie, {
      method: "POST",
      body: { title: "c", format: "code", language: "py", content: "print(1)" },
    });
    const { id: cid } = (await r.json()) as { id: string };
    expect((await version(cid, 1))?.entry).toBe("main.py");
  });
});
