// M2 whole-track review: cross-task seams.
import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { qk } from "../src/api/queries";
import { installHarness, lastClient, mount, server } from "./harness";

installHarness();

const NAME = fixtures.me.instance.name; // "Acme Artifacts"

describe("instance name", () => {
  it("is in document.title", async () => {
    mount("/settings/agents");
    await screen.findByRole("heading", { name: "Personal access tokens" });
    expect(document.title).toBe(`Agents · ${NAME}`);
  });
});

describe("role change mid-session", () => {
  it("a demoted admin leaves admin settings once an admin endpoint 404s", async () => {
    const router = mount("/settings/members");
    await screen.findByRole("combobox", { name: /^Role for / });
    // Another admin demotes this user; the server now answers admin routes with 404.
    server.use(
      http.get(`*${R.me}`, () =>
        HttpResponse.json({
          ...fixtures.me,
          user: { ...fixtures.me.user, role: "member" },
        }),
      ),
      http.get(`*${R.members}`, () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
      ),
    );
    await lastClient.invalidateQueries({ queryKey: qk.members });
    await waitFor(
      () => expect(router.state.location.pathname).toBe("/settings/agents"),
      { timeout: 3000 },
    );
    expect(
      screen.queryByRole("link", { name: "Instance" }),
    ).not.toBeInTheDocument();
  });
});
