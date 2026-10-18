import { QUOTA_MESSAGE } from "@oa/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  ApiError,
  appOrigin,
  isD1QuotaError,
  toErrorResponse,
} from "../src/http/errors.js";
import { securityHeaders } from "../src/http/middleware.js";

function appThrowing(e: unknown) {
  const app = new Hono();
  app.onError((err) => toErrorResponse(err));
  app.get("/x", () => {
    throw e;
  });
  return app;
}

describe("errors", () => {
  it("D1 quota error -> 503 quota_exceeded", async () => {
    const res = await appThrowing(
      new Error(
        "Your account has exceeded D1's free tier daily row read limit.",
      ),
    ).request("/x");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: "quota_exceeded", message: QUOTA_MESSAGE },
    });
  });

  it("ApiError not_found -> 404", async () => {
    const res = await appThrowing(new ApiError("not_found", "x")).request("/x");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "x" },
    });
  });

  it("ApiError details are included", async () => {
    const res = await appThrowing(
      new ApiError("bad_request", "m", { a: 1 }),
    ).request("/x");
    expect(
      ((await res.json()) as { error: { details: unknown } }).error.details,
    ).toEqual({ a: 1 });
  });

  it("generic Error -> 500 internal without stack", async () => {
    const err = new Error("boom");
    const res = await appThrowing(err).request("/x");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("internal");
    expect(text).not.toContain("boom");
    expect(text).not.toContain("at ");
  });

  it("isD1QuotaError", () => {
    expect(isD1QuotaError(new Error("exceeded D1's free tier daily"))).toBe(
      true,
    );
    expect(isD1QuotaError(new Error("other"))).toBe(false);
    expect(isD1QuotaError("str")).toBe(false);
  });

  it("appOrigin", () => {
    expect(appOrigin({ APP_HOST: "a.b", ENVIRONMENT: "dev" } as Env)).toBe(
      "http://a.b",
    );
    expect(
      appOrigin({ APP_HOST: "a.b", ENVIRONMENT: "production" } as Env),
    ).toBe("https://a.b");
  });
});

describe("headers on thrown errors", () => {
  it("securityHeaders survive onError", async () => {
    const app = new Hono();
    app.use(securityHeaders({ frameDeny: true }));
    app.onError((err) => toErrorResponse(err));
    app.get("/x", () => {
      throw new Error("boom");
    });
    const res = await app.request("/x");
    expect(res.status).toBe(500);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
