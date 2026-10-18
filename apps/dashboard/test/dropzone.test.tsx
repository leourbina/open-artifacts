import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installHarness, mount } from "./harness";

installHarness();

const drag = (type: string, types = ["Files"]) =>
  act(() => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types } });
    window.dispatchEvent(e);
  });

describe("library drop zone", () => {
  it("shows the overlay for file drags only, survives nested enter/leave, Esc cancels", async () => {
    mount("/");
    await screen.findByRole("button", { name: "Upload files" });
    drag("dragenter", ["text/plain"]);
    expect(screen.queryByText(/Drop files/)).toBeNull();
    drag("dragenter");
    drag("dragenter");
    drag("dragleave");
    expect(screen.getByText(/Drop files to create an artifact/)).toBeVisible();
    drag("dragleave");
    expect(screen.queryByText(/Drop files/)).toBeNull();
    drag("dragenter");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText(/Drop files/)).toBeNull();
  });

  it("picking files opens the dialog with the title defaulted from the entry", async () => {
    mount("/");
    const input = (await screen.findByTestId(
      "upload-files",
    )) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "report.md")] },
    });
    const title = await screen.findByLabelText("Title");
    await waitFor(() => expect(title).toHaveValue("report"));
  });
});
