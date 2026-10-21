// Sign-in negative cases for P5's cross-tenant suite (P2 T13). Each case
// takes two installs, A and B, gets real credentials from A (through the
// /__test/* hooks, T14) and asserts B refuses them. No cloudflare:workers
// import: the same catalog runs locally (xt.local.test.ts, two envs in one
// worker) and live against stg-a and stg-b (xt:live, plain fetch).
import { AUTH, R, TEST_HOOKS } from "@oa/shared";

export type Install = {
  /** Origin, e.g. https://stg-a.example.com. */
  origin: string;
  /** TEST_HOOK_KEY of this install. */
  hookKey: string;
  /** Session cookie name (__Host-oa_session in production). */
  sessionCookie: string;
  /** Pending-code cookie name (__Host-oa_code in production). */
  codeCookie: string;
  /** A Turnstile token the install accepts (its test secret), when it has Turnstile. */
  turnstileToken?: string;
  /** Sends a request to this install. */
  fetch(req: Request): Promise<Response>;
};

export type NegativeCase = {
  name: string;
  /** Needs separate D1/KV per install (true on live installs, not in one local worker). */
  liveOnly?: boolean;
  run(a: Install, b: Install): Promise<void>;
};

class Refusal extends Error {}

/** A short, non-reversible fingerprint of a response body. */
async function bodyHash(r: Response): Promise<string> {
  const text = await r
    .clone()
    .text()
    .catch(() => "");
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(d)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Failure messages carry the status and a body hash only (P5 rule): never a
 * key, code, cookie or body, so a failing release run can't leak them.
 */
async function expectStatus(
  r: Response,
  ok: number[],
  what: string,
): Promise<void> {
  if (!ok.includes(r.status))
    throw new Refusal(
      `${what}: expected ${ok.join("/")}, got ${r.status} (body sha256 ${await bodyHash(r)})`,
    );
}

const unique = (local: string) =>
  `${local}-${crypto.randomUUID().slice(0, 8)}@xt-guest.example`;

function send(
  to: Install,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  return to.fetch(
    new Request(`${to.origin}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    }),
  );
}

const hook = (to: Install, path: string, body: unknown = {}) =>
  send(to, path, {
    method: "POST",
    body,
    headers: { authorization: `Bearer ${to.hookKey}` },
  });

async function sessionOn(
  to: Install,
  role: "member" | "guest",
  email = unique(role),
) {
  const r = await hook(to, TEST_HOOKS.session, { email, role });
  await expectStatus(r, [200], `session hook on ${to.origin}`);
  const { cookie } = (await r.json()) as { cookie: string };
  return { email, cookie: `${to.sessionCookie}=${cookie}` };
}

const json = { "x-oa-request": "1", "sec-fetch-site": "same-origin" };

/** Requests a code at `to` for `email`; returns the pending cookie pair. */
async function requestCode(to: Install, email: string): Promise<string> {
  const r = await send(to, AUTH.codeRequest, {
    method: "POST",
    body: {
      email,
      ...(to.turnstileToken ? { turnstileToken: to.turnstileToken } : {}),
    },
    headers: json,
  });
  await expectStatus(r, [202], `code request on ${to.origin}`);
  const set = r.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${to.codeCookie}=`));
  if (!set) throw new Refusal("no pending cookie");
  return set.split(";")[0] as string;
}

export const SIGNIN_NEGATIVE_CASES: NegativeCase[] = [
  {
    name: "A's session cookie is refused at B",
    async run(a, b) {
      const { cookie } = await sessionOn(a, "member");
      await expectStatus(
        await send(a, R.me, { headers: { cookie } }),
        [200],
        "A /me",
      );
      await expectStatus(
        await send(b, R.me, { headers: { cookie } }),
        [401],
        "B /me with A's cookie",
      );
    },
  },
  {
    name: "A's code with A's pending cookie is refused at B",
    async run(a, b) {
      const { email } = await sessionOn(a, "guest");
      await sessionOn(b, "guest", email);
      const pendingA = await requestCode(a, email);
      const otp = await hook(a, TEST_HOOKS.otpLatest, { email });
      await expectStatus(otp, [200], "A otp hook");
      const { code } = (await otp.json()) as { code: string };
      const r = await send(b, AUTH.codeVerify, {
        method: "POST",
        body: { code },
        headers: {
          ...json,
          cookie: pendingA.replace(a.codeCookie, b.codeCookie),
        },
      });
      await expectStatus(r, [401], "B verify with A's code and pending cookie");
      if (
        r.headers
          .getSetCookie()
          .some((c) => c.startsWith(`${b.sessionCookie}=`))
      )
        throw new Refusal("B issued a session for A's code");
    },
  },
  {
    name: "A's pending-code cookie is no_pending at B",
    async run(a, b) {
      const { email } = await sessionOn(a, "guest");
      const pendingA = await requestCode(a, email);
      const r = await send(b, AUTH.codeVerify, {
        method: "POST",
        body: { code: "00000000" },
        headers: {
          ...json,
          cookie: pendingA.replace(a.codeCookie, b.codeCookie),
        },
      });
      await expectStatus(r, [401], "B verify with A's pending cookie");
      const body = (await r.json()) as {
        error: { details?: { reason?: string } };
      };
      if (body.error.details?.reason !== "no_pending")
        throw new Refusal(
          `expected no_pending, got ${body.error.details?.reason}`,
        );
    },
  },
  {
    name: "an unsolicited Google callback creates no session at B",
    async run(_a, b) {
      const r = await send(
        b,
        `${AUTH.callbackGoogle}?state=forged&code=forged`,
      );
      if (
        r.headers
          .getSetCookie()
          .some((c) => c.startsWith(`${b.sessionCookie}=`))
      )
        throw new Refusal("session set by a forged callback");
    },
  },
  {
    name: "A's PAT is refused at B (REST and /mcp)",
    liveOnly: true,
    async run(a, b) {
      const { cookie } = await sessionOn(a, "member");
      const t = await send(a, R.tokens, {
        method: "POST",
        body: { label: "xt" },
        headers: { ...json, cookie },
      });
      await expectStatus(t, [201], "A creates a PAT");
      const { token } = (await t.json()) as { token: string };
      const bearer = { authorization: `Bearer ${token}` };
      await expectStatus(
        await send(b, R.me, { headers: bearer }),
        [401],
        "B /me with A's PAT",
      );
      await expectStatus(
        await send(b, "/mcp", {
          method: "POST",
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          headers: { ...bearer, accept: "application/json, text/event-stream" },
        }),
        [401],
        "B /mcp with A's PAT",
      );
    },
  },
  {
    name: "A's OAuth access token is refused at B",
    liveOnly: true,
    async run(a, b) {
      const r = await hook(a, TEST_HOOKS.oauthClient);
      await expectStatus(r, [200], "A oauth-client hook");
      const { accessToken } = (await r.json()) as { accessToken: string };
      await expectStatus(
        await send(b, "/mcp", {
          method: "POST",
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: "application/json, text/event-stream",
          },
        }),
        [401],
        "B /mcp with A's OAuth token",
      );
    },
  },
];
