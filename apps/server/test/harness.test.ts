import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("binds D1, R2, KV and the DO", async () => {
  const e = env as unknown as Record<string, unknown>;
  for (const k of ["DB", "FILES", "OAUTH_KV", "ARTIFACT_RUNTIME"])
    expect(e[k]).toBeDefined();
  const ns = e.ARTIFACT_RUNTIME as DurableObjectNamespace;
  const res = await ns.get(ns.idFromName("x")).fetch("http://do/");
  expect(res.status).toBe(501);
});
