// OAuth consent security (M2 pentest, B14-2): live render, guest denial,
// client_name spoofing (hidden chars + HTML), redirect_uri validation,
// CSRF on the consent decision, and the approve/deny redirects.
import { APP, expect, loginAs, test } from "./fixtures";

const REDIRECT = "http://localhost:8977/callback";
const PKCE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URrbuALn64nMk0";

async function registerClient(client_name: string) {
  const res = await fetch(`${APP}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(201);
  return JSON.parse(text) as { client_id: string };
}

const authorize = (client_id: string, redirect_uri: string, state = "st4te") =>
  `${APP}/oauth/authorize?${new URLSearchParams({
    client_id,
    redirect_uri,
    response_type: "code",
    state,
    scope: "mcp",
    code_challenge: PKCE,
    code_challenge_method: "S256",
  })}`;

test("member consents to a hostile-named client: sanitized render, approve redirects with code+state", async ({
  page,
}) => {
  const hostile = "<script>alert(1)</script>\u202eOpenArtifacts\u200bTrust";
  const { client_id } = await registerClient(hostile);
  await loginAs(page, "consent-member@e2e.test", "member");

  await page.goto(authorize(client_id, REDIRECT));

  // The name renders as escaped text: no script element, no bidi/zero-width.
  const html = await page.content();
  expect(html).not.toContain("<script>alert(1)");
  expect(html).not.toContain("\u202e");
  expect(html).not.toContain("\u200b");
  await expect(page.getByText("alert(1)").first()).toBeVisible();

  // Approve: the only navigation the browser is given is the registered
  // redirect_uri, carrying the state back and a code (route interception is
  // unreliable for redirect-followed form posts, so assert on the 302 itself).
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith("/oauth/authorize"),
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const res = await posted;
  expect(res.status()).toBe(302);
  const loc = new URL(res.headers()["location"] ?? "");
  expect(`${loc.protocol}//${loc.host}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("st4te");
  expect(loc.searchParams.get("code")).toBeTruthy();
});

test("deny redirects with error=access_denied and no code", async ({
  page,
}) => {
  const { client_id } = await registerClient("Deny Probe");
  await loginAs(page, "deny-member@e2e.test", "member");
  await page.goto(authorize(client_id, REDIRECT));
  // Ensure the consent form is up before wiring the response listener.
  await expect(
    page.getByRole("button", { name: "Deny", exact: true }),
  ).toBeVisible();
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith("/oauth/authorize"),
  );
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  const res = await posted;
  expect(res.status()).toBe(302);
  const loc = new URL(res.headers()["location"] ?? "");
  expect(`${loc.protocol}//${loc.host}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get("error")).toBe("access_denied");
  expect(loc.searchParams.get("code")).toBeNull();
});

test("guests cannot consent: members-only page", async ({ page }) => {
  const { client_id } = await registerClient("Guest Probe");
  await loginAs(page, "guest-probe@e2e.test", "guest");
  const res = await page.request.get(authorize(client_id, REDIRECT));
  expect(res.status()).toBe(403);
  expect(await res.text()).toContain("Only members can connect agents");
});

test("a redirect_uri that was not registered is refused, never redirected to", async ({
  page,
}) => {
  const { client_id } = await registerClient("Redirect Probe");
  await loginAs(page, "redirect-member@e2e.test", "member");
  await page.goto(authorize(client_id, "https://evil.test/cb"));
  await expect(page.getByText("Can't connect this agent")).toBeVisible();
  // Still on the app's error page: the browser never navigated to the attacker.
  expect(new URL(page.url()).host).not.toBe("evil.test");
  expect(page.url()).toContain(`${APP}/oauth`);
});

test("consent decision without the CSRF token is rejected", async ({
  page,
}) => {
  const { client_id } = await registerClient("CSRF Probe");
  await loginAs(page, "csrf-member@e2e.test", "member");
  await page.goto(authorize(client_id, REDIRECT));
  const handle = await page.locator('input[name="request"]').inputValue();
  const res = await page.request.post(`${APP}/oauth/authorize`, {
    form: { decision: "approve", request: handle },
  });
  expect(res.status()).toBe(403);
  expect(await res.text()).toContain("This page expired");
});

test("cross-site consent decision is rejected", async ({ page }) => {
  const { client_id } = await registerClient("Fetch Site Probe");
  await loginAs(page, "fetchsite-member@e2e.test", "member");
  await page.goto(authorize(client_id, REDIRECT));
  const handle = await page.locator('input[name="request"]').inputValue();
  const res = await page.request.post(`${APP}/oauth/authorize`, {
    headers: { "sec-fetch-site": "cross-site" },
    form: { decision: "approve", request: handle, csrf: "x" },
  });
  expect(res.status()).toBe(403);
});
