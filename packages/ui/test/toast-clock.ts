import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * Radix renders a toast's live-region text two animation frames after mount
 * and removes it 1s later. Under CPU load a real-time sleep can land on
 * either side of that window, so tests drive the clock by hand.
 */
export function useToastClock() {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
}

/** Advances past the two frames Radix waits before announcing. */
export const flushAnnouncement = () =>
  act(() => {
    vi.advanceTimersByTime(100);
  });
