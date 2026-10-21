import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { direct, mailer } from "./auth-helpers.js";
import { type Install, SIGNIN_NEGATIVE_CASES } from "./xt/signin-negative.js";

// P2 Task 13: the sign-in negative catalog against two local installs (one
// worker, two envs: different secrets, install ids and hook keys). Cases that
// need separate D1/KV per install run live only (xt:live).
const m = mailer();
function local(id: string, secret: string, hookKey: string): Install {
  const e = {
    ...direct({ INSTALL_ID: id, SESSION_SECRET: secret }),
    ...m.env,
    TEST_HOOKS: "1",
    TEST_HOOK_KEY: hookKey,
  } as Env;
  return {
    origin: "http://app.localhost",
    hookKey,
    sessionCookie: "oa_session",
    codeCookie: "oa_code",
    async fetch(req) {
      const waits: Promise<unknown>[] = [];
      const r = await worker.fetch(
        new Request(req, {
          headers: new Headers([
            ...req.headers,
            [
              "cf-connecting-ip",
              `198.51.100.${Math.floor(Math.random() * 250)}`,
            ],
          ]),
        }) as never,
        e,
        {
          waitUntil: (p: Promise<unknown>) => waits.push(p),
          passThroughOnException() {},
        } as never,
      );
      await Promise.all(waits);
      return r;
    },
  };
}
const A = local("xt-a", "a".repeat(40), "A".repeat(32));
const B = local("xt-b", "b".repeat(40), "B".repeat(32));

describe("sign-in negative catalog (local)", () => {
  for (const c of SIGNIN_NEGATIVE_CASES) {
    const t = c.liveOnly ? it.skip : it;
    t(c.name, () => c.run(A, B));
  }

  // The catalog must fail when B is really A (same secret): it can catch a leak.
  it.each(SIGNIN_NEGATIVE_CASES.filter((c) => !c.liveOnly).slice(0, 2))(
    "catches a broken install: $name",
    async (c) => {
      await expect(c.run(A, A)).rejects.toThrow();
    },
  );
});
