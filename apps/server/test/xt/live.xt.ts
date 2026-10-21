import { describe, it } from "vitest";
import { type Install, SIGNIN_NEGATIVE_CASES } from "./signin-negative.js";

// pnpm xt:live: the catalog against two live installs (vitest.xt.config.ts).
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required for xt:live`);
  return v;
};

function live(
  origin: string,
  hookKey: string,
  turnstileToken?: string,
): Install {
  return {
    origin: origin.replace(/\/$/, ""),
    hookKey,
    sessionCookie: "__Host-oa_session",
    codeCookie: "__Host-oa_code",
    turnstileToken,
    fetch: (req) => fetch(req),
  };
}

const A = live(need("XT_A"), need("XT_A_KEY"), process.env.XT_A_TURNSTILE);
const B = live(need("XT_B"), need("XT_B_KEY"), process.env.XT_B_TURNSTILE);

describe("sign-in negative catalog (live)", () => {
  for (const c of SIGNIN_NEGATIVE_CASES) it(c.name, () => c.run(A, B));
  for (const c of SIGNIN_NEGATIVE_CASES)
    it(`${c.name} (B to A)`, () => c.run(B, A));
});
