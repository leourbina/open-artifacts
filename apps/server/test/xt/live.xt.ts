import { describe, it } from "vitest";
import { readSecretFile } from "./secret-file.js";
import { type Install, SIGNIN_NEGATIVE_CASES } from "./signin-negative.js";

// pnpm xt:live: the catalog against two live installs (vitest.xt.config.ts).
// Origins come from env (XT_A, XT_B); credentials ONLY from 0600 files
// (XT_A_KEY_FILE, XT_B_KEY_FILE, XT_TURNSTILE_FILE), each read once.
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required for xt:live`);
  return v;
};
const turnstile = process.env.XT_TURNSTILE_FILE
  ? readSecretFile(process.env.XT_TURNSTILE_FILE)
  : undefined;

function live(origin: string, hookKey: string): Install {
  return {
    origin: origin.replace(/\/$/, ""),
    hookKey,
    sessionCookie: "__Host-oa_session",
    codeCookie: "__Host-oa_code",
    turnstileToken: turnstile,
    fetch: (req) => fetch(req),
  };
}

const A = live(need("XT_A"), readSecretFile(need("XT_A_KEY_FILE")));
const B = live(need("XT_B"), readSecretFile(need("XT_B_KEY_FILE")));

describe("sign-in negative catalog (live)", () => {
  for (const c of SIGNIN_NEGATIVE_CASES) it(c.name, () => c.run(A, B));
  for (const c of SIGNIN_NEGATIVE_CASES)
    it(`${c.name} (B to A)`, () => c.run(B, A));
});
