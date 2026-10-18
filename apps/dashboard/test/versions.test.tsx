import { diffPath, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { installHarness, mount, seen, server } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
  }),
}));

installHarness();

const id = (title: string) =>
  (fixtures.artifacts.find((a) => a.title === title) as { id: string }).id;
const OWNED = id("Landing page");
const VIEWER = id("Onboarding guide");
const SCRIPT = id("Parser script");
const panel = (aid: string) => `${viewerPath(aid)}?panel=open&tab=versions`;

describe("versions panel", () => {
  it("restore confirms, calls the route and navigates to the new version", async () => {
    const router = mount(panel(OWNED));
    await screen.findByText("Update 2");
    const row = screen
      .getByText("Initial version")
      .closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Restore" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restore version" }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED, 3)),
    );
    expect(seen.some((u) => u.pathname === R.restoreVersion(OWNED, 1))).toBe(
      true,
    );
  });

  it("editors see Restore, viewers do not", async () => {
    mount(panel(VIEWER));
    await screen.findByText("Initial version");
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("Load older versions fetches with before", async () => {
    mount(panel(SCRIPT));
    await screen.findByText("Update 25");
    expect(screen.queryByText("Update 5")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Load older versions" }),
    );
    await screen.findByText("Update 5");
    expect(seen.some((u) => u.searchParams.get("before") === "6")).toBe(true);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load older versions" }),
      ).toBeNull(),
    );
  });

  it("tab and panel state live in the URL", async () => {
    const router = mount(`${viewerPath(OWNED)}`);
    await screen.findByRole("button", { name: "Share" });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        panel: "open",
        tab: "share",
      }),
    );
    expect(screen.getByRole("tab", { name: "Versions" })).toBeInTheDocument();
  });
});

describe("diff", () => {
  it("shows the exact added and removed lines for v1 to v2", async () => {
    mount(diffPath(OWNED, 1, 2));
    const del = await screen.findByText("<!doctype html><h1>Landing v1</h1>");
    const add = screen.getByText(
      '<!doctype html><link rel="stylesheet" href="style.css"><h1>Landing v2</h1>',
    );
    expect(del.closest("tr")).toHaveAttribute("data-kind", "del");
    expect(add.closest("tr")).toHaveAttribute("data-kind", "add");
    expect(screen.getByText("style.css")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
  });

  it("says Binary file changed for NUL bytes", async () => {
    server.use(
      http.get(
        `*/api/v1/artifacts/${SCRIPT}/versions/:v/files/*`,
        () =>
          new HttpResponse("a\0b", {
            headers: { "content-type": "text/plain" },
          }),
      ),
    );
    mount(diffPath(SCRIPT, 1, 2));
    expect(await screen.findByText("Binary file changed")).toBeInTheDocument();
  });

  it("refuses to diff files over 1 MB", async () => {
    server.use(
      http.get(
        `*/api/v1/artifacts/${SCRIPT}/versions/:v/files/*`,
        () =>
          new HttpResponse("x".repeat(1_100_000), {
            headers: { "content-type": "text/plain" },
          }),
      ),
    );
    mount(diffPath(SCRIPT, 1, 2));
    expect(
      await screen.findByText("File too large to diff"),
    ).toBeInTheDocument();
  });

  it("invalid versions are not found", async () => {
    mount(diffPath(OWNED, 0, 2));
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });

  it("previews use the exact sandbox", async () => {
    mount(diffPath(OWNED, 1, 2));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Preview" }));
    await waitFor(() =>
      expect(document.querySelectorAll("iframe")).toHaveLength(2),
    );
    for (const f of document.querySelectorAll("iframe"))
      expect(f.getAttribute("sandbox")).toBe(
        "allow-scripts allow-forms allow-popups allow-modals allow-downloads",
      );
  });
});
