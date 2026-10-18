import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router";

// TODO: enable MSW browser mode for VITE_MOCK=1 once F3 mocks (@oa/shared/mocks) land.
const queryClient = new QueryClient();

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");
createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
