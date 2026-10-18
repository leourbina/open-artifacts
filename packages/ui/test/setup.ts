import { afterEach, vi } from "vitest";
import { resetToasts } from "../src/components/Toast";

// The toast queue is module state; without this, toasts from one test show
// up in the next test's <Toaster />. Runs after each file's own cleanup.
afterEach(() => {
  resetToasts();
  vi.useRealTimers();
});
