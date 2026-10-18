import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Member, newId, PageSchema, R, SearchHitSchema } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login, runIndex } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase().replace(/\d/g, "k");
const Hits = PageSchema(SearchHitSchema);
let o: { cookie: string; member: Member };
beforeAll(async () => {
  const l = await login(`rev-${tag}@x.com`);
  o = { cookie: l.cookie, member: (await getUser(env, l.userId))! };
});
const pub = (i: Record<string, unknown>) =>
  publish(env, o.member, i as never, null);
const found = async (q: string) =>
  Hits.parse(
    await (
      await api(app, `${R.search}?q=${encodeURIComponent(q)}`, o.cookie)
    ).json(),
  ).items.map((h) => h.id);
const inDo = <T>(id: string, cb: (i: ArtifactRuntime) => T | Promise<T>) =>
  runInDurableObject(
    runtimeStub(
      env as Env,
      id,
    ) as unknown as DurableObjectStub<ArtifactRuntime>,
    cb,
  );

describe("C3 review", () => {
  it("a version publish that renames is searchable by the new title before indexing", async () => {
    const a = await pub({
      title: `Alpha${tag}`,
      format: "markdown",
      content: "x",
    });
    await runIndex(a.id);
    await pub({
      id: a.id,
      title: `Gamma${tag}`,
      format: "markdown",
      content: "y",
    });
    expect(await found(`gamma${tag}`)).toEqual([a.id]);
  });
  it("a same-version re-enqueue (undelete) during an index run is not dropped", async () => {
    const a = await pub({ title: "r", format: "markdown", content: "x" });
    await inDo(a.id, (i) => {
      i.indexer = async () => {
        await i.scheduleIndex(a.id, 1); // undelete arriving mid-run
      };
    });
    await runIndex(a.id);
    expect(await inDo(a.id, (i) => i.pendingIndex())).not.toBeNull();
  });
});
