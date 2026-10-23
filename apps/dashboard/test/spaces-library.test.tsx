// Hosted P4 Task 5: the library's space filter, in the URL and in the query.
import { screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { calls, installHarness, mount, mountHosted } from "./harness";

installHarness();

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
