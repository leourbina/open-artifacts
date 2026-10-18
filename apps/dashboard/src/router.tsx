import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { NotFound } from "./pages/NotFound";

// Placeholders; later tasks replace each with the real page.
const page = (title: string) => () => <h1>{title}</h1>;

const root = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFound,
});
const route = (path: string, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => root, path, component });

const library = (path: string, scope: string) =>
  route(path, page(`Library: ${scope}`));

const search = createRoute({
  getParentRoute: () => root,
  path: "/search",
  validateSearch: (s: Record<string, unknown>) => ({
    q: typeof s.q === "string" ? s.q : "",
  }),
  component: page("Search"),
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
  route("/no-access", NotFound),
  route("*", NotFound),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
