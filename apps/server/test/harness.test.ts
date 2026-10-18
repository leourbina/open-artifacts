import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("binds D1, R2, KV and the DO", async () => {
  const e = env as unknown as Record<string, unknown>;
  for (const k of ["DB", "BLOBS", "KV", "RUNTIME"]) expect(e[k]).toBeDefined();
  const ns = e.RUNTIME as DurableObjectNamespace;
  const res = await ns.get(ns.idFromName("x")).fetch("http://do/");
  expect(res.status).toBe(501);
});
