// Hosted P4 Task 5: the library's space filter, in the URL and in the query.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { calls, installHarness, mount, mountHosted } from "./harness";

installHarness();

const PERSONAL = "Ab3dEfGhJk4mNpQr";
const listCalls = (seen: { path: string; search: URLSearchParams }[]) =>
  seen.filter((c) => c.path === "/api/v1/artifacts");

it("spaces off: no spaces request and no spaceId", async () => {
  const seen = calls("GET");
  mount("/?space=SpEngNpQrSt2uVwX");
  await screen.findByRole("link", { name: "Landing page" });
  expect(seen.some((c) => c.path.startsWith("/api/v1/spaces"))).toBe(false);
  expect(listCalls(seen)[0].search.get("spaceId")).toBeNull();
  expect(listCalls(seen)[0].search.get("scope")).toBe("all");
});

// The mocks' list route still validates the core ListQuerySchema, which has no
// scope "space" (the contract's HostedListQuery arrives with the server), so
// this asserts the request the dashboard sends, not the rendered page.
it("?space=Engineering requests scope=space", async () => {
  const seen = calls("GET");
  mountHosted("/?space=SpEngNpQrSt2uVwX");
  // The first list call runs before /me answers; the space filter follows it.
  await waitFor(() =>
    expect(listCalls(seen).at(-1)?.search.get("scope")).toBe("space"),
  );
  const q = listCalls(seen).at(-1)?.search;
  expect([q?.get("scope"), q?.get("spaceId")]).toEqual([
    "space",
    "SpEngNpQrSt2uVwX",
  ]);
});

it("?space=<personal> requests scope=mine", async () => {
  const seen = calls("GET");
  mountHosted("/?space=Ab3dEfGhJk4mNpQr");
  await waitFor(() =>
    expect(listCalls(seen).some((c) => c.search.get("scope") === "mine")).toBe(
      true,
    ),
  );
});

it("an unknown space clears the param without a lookup", async () => {
  const seen = calls("GET");
  const router = mountHosted("/?space=SpNopeNpQrSt9uVw");
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(seen.some((c) => c.path === "/api/v1/spaces/SpNopeNpQrSt9uVw")).toBe(
    false,
  );
});

it("Clients (admin view, no role) isn't a library space: the param clears", async () => {
  const router = mountHosted("/?space=SpCliNpQrSt4uVwX");
  await waitFor(() => expect(router.state.location.search).toEqual({}));
});

it("search carries spaceId", async () => {
  const seen = calls("GET");
  mountHosted("/search?q=notes&space=SpEngNpQrSt2uVwX");
  await waitFor(() =>
    expect(
      seen.some(
        (c) =>
          c.path === "/api/v1/search" &&
          c.search.get("spaceId") === "SpEngNpQrSt2uVwX",
      ),
    ).toBe(true),
  );
});

it("off the library, ?space= belongs to the page: it's never cleared (the header search mounts everywhere)", async () => {
  // /settings/spaces?space=<id> names a space the admin may have no role in.
  const router = mountHosted("/settings/profile?space=SpCliNpQrSt4uVwX");
  // /me has answered once the sidebar's Spaces section shows.
  await screen.findByRole("navigation", { name: "Spaces" });
  expect(router.state.location.search).toEqual({ space: "SpCliNpQrSt4uVwX" });
  // The header search isn't scoped there either.
  expect(
    screen.queryByRole("button", { name: "Search everywhere" }),
  ).toBeNull();
});

// -- a space-scoped 404 (the role is gone, /me is stale)

const ENG = "SpEngNpQrSt2uVwX";
const notFound = http.get("*/api/v1/artifacts", ({ request }) =>
  new URL(request.url).searchParams.has("spaceId")
    ? HttpResponse.json(
        { error: { code: "not_found", message: "Space not found" } },
        { status: 404 },
      )
    : undefined,
);
const serverError = http.get("*/api/v1/artifacts", ({ request }) =>
  new URL(request.url).searchParams.has("spaceId")
    ? HttpResponse.json(
        { error: { code: "internal", message: "Boom" } },
        { status: 500 },
      )
    : undefined,
);
const REVOKED =
  "Your role in it changed or the space was deleted. Ask a space manager if you think this is a mistake.";

it("a 404 on a space-scoped list says access is gone, with Back to Library", async () => {
  const router = mountHosted(`/?space=${ENG}`, true, undefined, [notFound]);
  expect(
    await screen.findByText("You no longer have access to Engineering."),
  ).toBeVisible();
  expect(screen.getByText(REVOKED)).toBeVisible();
  expect(screen.queryByText("Couldn't load the library.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to Library" }));
  await screen.findAllByText("Q4 report");
  expect(router.state.location.search).toEqual({});
  expect(
    screen.queryByText("You no longer have access to Engineering."),
  ).toBeNull();
});

it("the 404 refetches /me", async () => {
  const seen = calls("GET");
  mountHosted(`/?space=${ENG}`, true, undefined, [notFound]);
  await screen.findByText("You no longer have access to Engineering.");
  await waitFor(() =>
    expect(seen.filter((c) => c.path === "/api/v1/me").length).toBeGreaterThan(
      1,
    ),
  );
});

it("without a space name the notice says this space", async () => {
  mountHosted(
    `/?space=${PERSONAL}`,
    true,
    (m) => ({ ...m, user: { ...m.user, name: null } }),
    // Personal reads as scope=mine with no spaceId: 404 every list.
    [
      http.get("*/api/v1/artifacts", () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Space not found" } },
          { status: 404 },
        ),
      ),
    ],
  );
  expect(
    await screen.findByText("You no longer have access to this space."),
  ).toBeVisible();
});

it("other errors keep Couldn't load the library", async () => {
  mountHosted(`/?space=${ENG}`, true, undefined, [serverError]);
  expect(await screen.findByText("Couldn't load the library.")).toBeVisible();
  expect(screen.queryByText(/You no longer have access/)).toBeNull();
});
