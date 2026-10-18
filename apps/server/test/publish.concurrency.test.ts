import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { api, login } from "./helpers.js";

const app = createApp();
let owner: { cookie: string; userId: string };

beforeAll(async () => {
  owner = await login(`conc-${newId().slice(0, 6).toLowerCase()}@x.com`);
});

describe("publish concurrency", () => {
  it("5 parallel publishes → versions 2..6", async () => {
    const r = await api(app, R.artifacts, owner.cookie, {
      method: "POST",
      body: { title: "race", format: "markdown", content: "v1" },
    });
    const { id } = (await r.json()) as { id: string };
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        api(app, R.versions(id), owner.cookie, {
          method: "POST",
          body: { format: "markdown", content: `v${i + 1}` },
        }).then(async (x) => {
          expect(x.status).toBe(201);
          return ((await x.json()) as { version: number }).version;
        }),
      ),
    );
    expect(new Set(results)).toEqual(new Set([2, 3, 4, 5, 6]));
    const a = await env.DB.prepare(
      "select current_version from artifacts where id = ?",
    )
      .bind(id)
      .first<{ current_version: number }>();
    expect(a?.current_version).toBe(6);
    const n = await env.DB.prepare(
      "select count(*) as n from versions where artifact_id = ? and version > 1",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(n?.n).toBe(5);
  });
});
