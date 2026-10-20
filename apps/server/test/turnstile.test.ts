import { afterEach, describe, expect, it, vi } from "vitest";
import { authConfig } from "../src/auth/config.js";
import { verifyTurnstile } from "../src/auth/turnstile.js";
import { direct, trial } from "./auth-helpers.js";

const siteverify = (reply: () => Response | Promise<Response>) => {
  const calls: URLSearchParams[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    expect(req.url).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    calls.push(new URLSearchParams(await req.text()));
    return reply();
  });
  return calls;
};
afterEach(() => vi.restoreAllMocks());

describe("verifyTurnstile", () => {
  it("passes the secret, token and IP; true only on success: true", async () => {
    const calls = siteverify(() => Response.json({ success: true }));
    expect(
      await verifyTurnstile(authConfig(trial()), "tok", "203.0.113.1"),
    ).toBe(true);
    expect(Object.fromEntries(calls[0] ?? [])).toEqual({
      secret: "s",
      response: "tok",
      remoteip: "203.0.113.1",
    });
  });

  it("fails closed: refusal, HTTP error, network error, no token, not configured", async () => {
    siteverify(() => Response.json({ success: false }));
    expect(await verifyTurnstile(authConfig(trial()), "tok", null)).toBe(false);
    vi.restoreAllMocks();
    siteverify(() => new Response("x", { status: 500 }));
    expect(await verifyTurnstile(authConfig(trial()), "tok", null)).toBe(false);
    vi.restoreAllMocks();
    siteverify(() => {
      throw new Error("down");
    });
    expect(await verifyTurnstile(authConfig(trial()), "tok", null)).toBe(false);
    expect(await verifyTurnstile(authConfig(trial()), undefined, null)).toBe(
      false,
    );
    expect(await verifyTurnstile(authConfig(direct()), "tok", null)).toBe(
      false,
    );
  });
});
