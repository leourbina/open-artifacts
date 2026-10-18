import { FormatSchema } from "@oa/shared";
import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { AppLayout } from "./layout/AppLayout";
import { Library } from "./library/Library";
import { SearchPage } from "./library/Search";
import type { Scope } from "./library/useLibraryQuery";
import { NoAccess } from "./pages/NoAccess";
import { NotFound } from "./pages/NotFound";
import { SignIn } from "./pages/SignIn";

// Placeholders; later tasks replace each with the real page.
const page = (title: string) => () => <h1>{title}</h1>;

// Query values stay strings: `?q=007` must not become the number 7.
const parseSearch = (qs: string) =>
  Object.fromEntries(new URLSearchParams(qs.replace(/^\?/, "")));
const stringifySearch = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o))
    if (v != null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

const root = createRootRoute({
  component: AppLayout,
  notFoundComponent: NotFound,
});
const route = (path: string, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => root, path, component });

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const library = (path: string, scope: Scope) =>
  createRoute({
    getParentRoute: () => root,
    path,
    validateSearch: (s: Record<string, unknown>) => {
      const format = FormatSchema.safeParse(s.format);
      const view = s.view === "grid" || s.view === "list" ? s.view : undefined;
      return {
        ...(format.success && { format: format.data }),
        ...(str(s.agent) && { agent: str(s.agent) }),
        ...(view && { view }),
      };
    },
    component: () => <Library scope={scope} />,
  });

const search = createRoute({
  getParentRoute: () => root,
  path: "/search",
  validateSearch: (s: Record<string, unknown>) => ({
    q: s.q == null ? "" : String(s.q),
  }),
  component: SearchPage,
});

const routeTree = root.addChildren([
  library("/", "all"),
  library("/mine", "mine"),
  library("/shared", "shared"),
  library("/team", "team"),
  search,
  route("/a/$id", page("Viewer")),
  route("/a/$id/v/$v", page("Viewer")),
  route("/a/$id/diff/$from/$to", page("Diff")),
  route("/settings/members", page("Members")),
  route("/settings/agents", page("Agents")),
  route("/settings/instance", page("Instance")),
  route("/settings/usage", page("Usage")),
  route("/no-access", NoAccess),
  route("/sign-in", () => (
    <SignIn failed={new URLSearchParams(location.search).has("error")} />
  )),
  route("*", NotFound),
]);

export const createAppRouter = (history?: RouterHistory) =>
  createRouter({ routeTree, history, parseSearch, stringifySearch });

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
