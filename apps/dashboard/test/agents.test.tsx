import { R, type TokenCreated } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { snippets } from "../src/settings/snippets";
import * as h from "./harness";
import { installHarness, mount, server } from "./harness";

installHarness();

const URL_ = fixtures.me.instance.mcpUrl;
const SECRET = "oa_pat_SECRETSECRETSECRETSECRETSECRET12";

describe("snippets", () => {
  it("covers 5 agents x 2 variants and contains the url verbatim", () => {
    const all = snippets(URL_);
    expect(all).toHaveLength(10);
    expect(new Set(all.map((s) => s.agent)).size).toBe(5);
    for (const s of all) expect(s.code).toContain(URL_);
  });
  it("token variants send a Bearer header, with a placeholder by default", () => {
    for (const s of snippets(URL_).filter((s) => s.variant === "token")) {
      expect(s.code).toContain("Authorization");
      expect(s.code).toContain("Bearer <YOUR_TOKEN>");
    }
    for (const s of snippets(URL_).filter((s) => s.variant === "oauth"))
      expect(s.code).not.toContain("Bearer");
    for (const s of snippets(URL_, SECRET).filter((s) => s.variant === "token"))
      expect(s.code).toContain(`Bearer ${SECRET}`);
  });
  it("escapes per language", () => {
    const evil = `https://x.test/mcp"'\\$(id)`;
    for (const s of snippets(evil, `t"'`)) {
      if (s.language === "json") {
        const v = JSON.stringify(JSON.parse(s.code));
        expect(v).toContain(JSON.stringify(evil).slice(1, -1));
      }
      if (s.language === "toml")
        expect(s.code).toContain(`url = ${JSON.stringify(evil)}`);
      if (s.language === "bash")
        expect(s.code).toContain(`'https://x.test/mcp"'\\''\\$(id)'`);
    }
  });
});

describe("Agents settings", () => {
  it("shows snippets with a copy button; a denied clipboard toasts danger", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mount("/settings/agents");
    const copy = await screen.findByRole("button", {
      name: /copy command|copy config/i,
    });
    expect(screen.getByText(/claude mcp add/)).toBeTruthy();
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await screen.findByText(/couldn't copy/i);
  });

  it("toggles to the Token variant", async () => {
    mount("/settings/agents");
    fireEvent.click(await screen.findByRole("radio", { name: "Token" }));
    expect(
      (await screen.findAllByText(/Authorization: Bearer <YOUR_TOKEN>/))[0],
    ).toBeTruthy();
  });

  it("revokes an OAuth client only after confirm, via DELETE", async () => {
    const deletes: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "DELETE")
        deletes.push(new URL(request.url).pathname);
    });
    mount("/settings/agents");
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke Example MCP client" }),
    );
    expect(deletes).toEqual([]);
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: /^revoke/i }));
    await waitFor(() =>
      expect(deletes).toEqual([
        R.oauthClient(fixtures.oauthClients[0]?.grantId ?? ""),
      ]),
    );
  });

  it("revokes a token via DELETE after confirm; null lastUsedAt reads Never", async () => {
    const deletes: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "DELETE")
        deletes.push(new URL(request.url).pathname);
    });
    mount("/settings/agents");
    await screen.findByText("laptop");
    expect(screen.getAllByText("Never").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Revoke laptop" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: /^revoke/i }));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toBe(R.token(fixtures.tokens[0]?.id ?? ""));
  });

  it("shows a created token once, feeds snippets, and drops it on close", async () => {
    const created: TokenCreated = {
      id: "newtoken00000001",
      label: "ci",
      createdAt: "2026-01-03T00:00:00.000Z",
      lastUsedAt: null,
      token: SECRET,
    };
    let sent: unknown;
    server.use(
      http.post("*/api/v1/tokens", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    mount("/settings/agents");
    fireEvent.click(
      await screen.findByRole("button", { name: "Create token" }),
    );
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText("Label"), {
      target: { value: "  ci  " },
    });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await within(await screen.findByRole("dialog")).findByText(SECRET);
    expect(sent).toEqual({ label: "ci" });
    expect(screen.getByText("You won't see this again.")).toBeTruthy();
    expect(localStorage.length).toBe(0);
    expect(location.href).not.toContain(SECRET);
    fireEvent.click(
      screen.getByRole("button", { name: "Show snippets with this token" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).toContain(SECRET); // in the snippet view
    fireEvent.click(screen.getByRole("radio", { name: "Token" }));
    expect(document.body.textContent).toContain(`Bearer ${SECRET}`);
  });

  it("removes the token from the DOM and the query/mutation cache on close", async () => {
    const created = {
      id: "newtoken00000002",
      label: "x",
      createdAt: "2026-01-03T00:00:00.000Z",
      lastUsedAt: null,
      token: SECRET,
    };
    server.use(
      http.post("*/api/v1/tokens", () =>
        HttpResponse.json(created, { status: 201 }),
      ),
    );
    mount("/settings/agents");
    fireEvent.click(
      await screen.findByRole("button", { name: "Create token" }),
    );
    const dlg = await screen.findByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText("Label"), {
      target: { value: "x" },
    });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await screen.findByText(SECRET);
    const dump = () =>
      JSON.stringify([
        h.lastClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
        h.lastClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state.data),
      ]);
    expect(dump()).not.toContain(SECRET);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
    expect(dump()).not.toContain(SECRET);
  });
});
