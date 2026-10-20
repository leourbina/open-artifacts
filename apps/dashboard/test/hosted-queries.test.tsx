// Hosted P4 Task 2: query hooks and sign-in calls against the hosted mocks.
import { renderHook, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it, vi } from "vitest";
import { requestCode, useAuthProviders, verifyCode } from "../src/api/auth";
import {
  useDirectoryGroups,
  useMoveArtifact,
  usePutMapping,
  useRunTransfer,
  useSpaces,
} from "../src/api/queries";
import {
  calls,
  installHarness,
  lastClient,
  mountHosted,
  server,
  wait,
  wrapper,
} from "./harness";

installHarness();

it("useSpaces pages Clients, Engineering and Exec for an admin", async () => {
  mountHosted("/");
  const { result } = renderHook(() => useSpaces({ kind: "shared" }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(
    result.current.data?.pages[0].items.map((s) => [s.name, s.myRole]),
  ).toEqual([
    ["Clients", null],
    ["Engineering", "manager"],
    ["Exec", "viewer"],
  ]);
});

it("move invalidates the artifact, the library and spaces", async () => {
  mountHosted("/");
  const spy = vi.spyOn(lastClient, "invalidateQueries");
  const { result } = renderHook(() => useMoveArtifact("De6gHjKmNp7qRsTu"), {
    wrapper,
  });
  await result.current.mutateAsync("SpExcNpQrSt3uVwX").catch(() => {});
  expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual(
    expect.arrayContaining([
      ["artifact", "De6gHjKmNp7qRsTu"],
      ["artifacts"],
      ["spaces"],
    ]),
  );
});

it("a mapping 409 toasts the title and the mapped copy", async () => {
  mountHosted("/", { directory: "frozen" });
  const { result } = renderHook(() => usePutMapping("SpEngNpQrSt2uVwX"), {
    wrapper,
  });
  await result.current
    .mutateAsync({ groupId: "gEng01", role: "manager" })
    .catch(() => {});
  expect(await screen.findByText("Couldn't change access.")).toBeVisible();
  expect(
    screen.getByText(
      "Directory sync is off, so this isn't available right now.",
    ),
  ).toBeVisible();
});

it("directory group search waits for two characters", async () => {
  mountHosted("/");
  const seen = calls("GET");
  renderHook(() => useDirectoryGroups("s"), { wrapper });
  await wait(50);
  expect(
    seen.filter((c) => c.path === "/api/v1/directory/groups"),
  ).toHaveLength(0);
});

it("directory group search sends q from two characters", async () => {
  mountHosted("/");
  const seen = calls("GET");
  const { result } = renderHook(() => useDirectoryGroups("sa"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const hit = seen.find((c) => c.path === "/api/v1/directory/groups");
  expect(hit?.search.get("q")).toBe("sa");
});

it("useRunTransfer posts the cursor it is given", async () => {
  mountHosted("/");
  const seen = calls("POST");
  const { result } = renderHook(() => useRunTransfer("Cr7tNpQrSt8uVwXy"), {
    wrapper,
  });
  await result.current
    .mutateAsync({
      to: { kind: "user", userId: "Bc4eFgHjKm5nPqRs" },
      cursor: "c1",
    })
    .catch(() => {});
  await waitFor(() =>
    expect(seen.at(-1)).toMatchObject({
      path: "/api/v1/members/Cr7tNpQrSt8uVwXy/transfer",
      body: {
        to: { kind: "user", userId: "Bc4eFgHjKm5nPqRs" },
        cursor: "c1",
      },
    }),
  );
});

it("requestCode returns the server's policy", async () => {
  mountHosted("/sign-in");
  await expect(requestCode({ email: "bob@example.com" })).resolves.toEqual({
    maskedEmail: "b***@example.com",
    expiresIn: 600,
    resendAfter: 60,
    codeLength: 8,
  });
});

it("verifyCode keeps 401 details", async () => {
  mountHosted("/sign-in");
  await requestCode({ email: "bob@example.com" });
  const e = await verifyCode("11111111").catch((x) => x);
  expect([e.status, e.details]).toEqual([
    401,
    { reason: "invalid_code", attemptsLeft: 4 },
  ]);
});

it("useAuthProviders reads a 404 as access mode", async () => {
  server.use(
    http.get("*/auth/providers", () => new HttpResponse(null, { status: 404 })),
  );
  const { result } = renderHook(() => useAuthProviders(), { wrapper });
  await waitFor(() => expect(result.current.data?.mode).toBe("access"));
});

it("self-hosted members list sends no status", async () => {
  const { useMembers } = await import("../src/api/queries");
  const seen = calls("GET");
  const { result } = renderHook(() => useMembers(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const hit = seen.find((c) => c.path === "/api/v1/members");
  expect(hit?.search.toString()).toBe("");
  expect(lastClient.getQueryData(["members", "active"])).toBeDefined();
});
