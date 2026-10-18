import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { makeQueryClient } from "./api/queryClient";
import { router } from "./router";
import "./styles.css";

/** Dev-only: serve the API from in-browser MSW handlers. Dead-code-eliminated from production builds. */
async function startMocks() {
  if (import.meta.env.VITE_MOCK !== "1") return;
  const [{ setupWorker }, { createHandlers }] = await Promise.all([
    import("msw/browser"),
    import("@oa/shared/mocks"),
  ]);
  const quotaExceeded =
    import.meta.env.VITE_MOCK_QUOTA === "1" ||
    new URLSearchParams(location.search).get("mock") === "quota";
  await setupWorker(...createHandlers({ quotaExceeded })).start({
    onUnhandledRequest: "bypass",
  });
}

await startMocks();
const queryClient = makeQueryClient();

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");
createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
