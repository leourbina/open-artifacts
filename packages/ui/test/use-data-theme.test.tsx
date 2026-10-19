// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDataTheme } from "../src/shadcn";

const Probe = () => <output>{useDataTheme()}</output>;

// jsdom has no matchMedia; each test installs its own.
function mockMatchMedia(matches: boolean) {
  const media = {
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
  return media;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
});

describe("useDataTheme", () => {
  it("renders light on the server", () => {
    expect(renderToString(<Probe />)).toContain(">light<");
  });

  it("follows a data-theme flip on <html>", async () => {
    mockMatchMedia(false);
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("light");
    await act(async () => {
      document.documentElement.dataset.theme = "dark";
    });
    expect(screen.getByRole("status").textContent).toBe("dark");
    await act(async () => {
      document.documentElement.dataset.theme = "light";
    });
    expect(screen.getByRole("status").textContent).toBe("light");
  });

  it("falls back to prefers-color-scheme without data-theme", () => {
    mockMatchMedia(true);
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("dark");
  });

  it("an explicit data-theme beats the OS preference", () => {
    mockMatchMedia(true);
    document.documentElement.dataset.theme = "light";
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("light");
  });

  it("disconnects the observer and the media listener on unmount", () => {
    const media = mockMatchMedia(false);
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { unmount } = render(<Probe />);
    expect(media.addEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(media.removeEventListener).toHaveBeenCalledWith(
      "change",
      media.addEventListener.mock.calls[0]?.[1],
    );
  });
});
