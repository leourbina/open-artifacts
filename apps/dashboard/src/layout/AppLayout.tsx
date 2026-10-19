import { AUTH, type Me } from "@oa/shared";
import { Avatar, Button, Menu, Toaster } from "@oa/ui";
import {
  Sidebar as ShSidebar,
  SidebarBrand,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { type MouseEvent, type ReactNode, useEffect } from "react";
import { ApiClientError } from "../api/client";
import { qk } from "../api/queries";
import { useRedirect } from "../auth/redirect";
import { useSignOut } from "../auth/signOut";
import { useMe } from "../auth/useMe";
import { SearchBox } from "../library/SearchBox";
import { EdgePanel } from "../pages/Edge";
import { CpuBanner } from "./CpuBanner";
import { DisplayNamePrompt } from "./DisplayNamePrompt";
import { QuotaBanner } from "./QuotaBanner";

const icon = (d: string) => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const I = {
  lib: icon("M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"),
  share: icon("M10.5 5.5 13 8l-2.5 2.5M13 8H5a3 3 0 0 0-3 3"),
  team: icon(
    "M6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM1.5 13.5c.5-2.5 2.3-3.8 4.5-3.8s4 1.3 4.5 3.8",
  ),
  usage: icon("M2.5 11a5.5 5.5 0 1 1 11 0M8 11l2.5-3"),
  gear: icon(
    "M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7",
  ),
};

/** Routes that render without the app shell (edge pages, viewer owns its chrome). */
const bareRoute = (p: string) => publicRoute(p) || p === "/no-access";
/** Routes an anonymous visitor may see. */
const publicRoute = (raw: string) => {
  const p = raw.toLowerCase(); // the router matches case-insensitively
  return p === "/sign-in" || p === "/no-access" || p.startsWith("/a/");
};

export function AppLayout() {
  const state = useMe();
  const redirect = useRedirect();
  const loc = useRouterState({ select: (s) => s.location });
  // The rendered leaf match: mid-navigation `location` is already the target while
  // the old match still renders, which would remount it under the other layout.
  const path =
    useRouterState({ select: (s) => s.matches.at(-1)?.pathname }) ??
    loc.pathname;
  const anonymous = state.status === "anonymous" && !publicRoute(path);

  useEffect(() => {
    if (anonymous)
      redirect(
        `${AUTH.login}?next=${encodeURIComponent(path + loc.searchStr)}`,
      );
  }, [anonymous, redirect, path, loc.searchStr]);

  const navigate = useNavigate();
  const guestHome =
    state.status === "authed" &&
    state.me.user.role === "guest" &&
    ["/", "/mine", "/team"].includes(path);
  useEffect(() => {
    if (guestHome) void navigate({ to: "/shared" as string, replace: true });
  }, [guestHome, navigate]);

  if (anonymous || guestHome) return <Toaster />;
  if (bareRoute(path))
    return (
      <main id="oa-main">
        <QuotaBanner />
        <Outlet />
        <Toaster />
      </main>
    );
  if (state.status === "error")
    return (
      <main id="oa-main">
        <QuotaBanner />
        <LoadError
          quota={
            state.error instanceof ApiClientError &&
            state.error.code === "quota_exceeded"
          }
        />
        <Toaster />
      </main>
    );
  const me = state.status === "authed" ? state.me : null;
  return (
    <SidebarProvider>
      <a
        href="#oa-main"
        className="sr-only z-[60] rounded-sm bg-[var(--oa-surface)] px-[var(--oa-space-2)] py-[var(--oa-space-1)] text-[var(--oa-text)] shadow-[var(--oa-shadow-2)] focus:not-sr-only focus:fixed focus:top-[var(--oa-space-2)] focus:left-[var(--oa-space-2)]"
      >
        Skip to content
      </a>
      <Sidebar me={me} path={path} />
      {/* SidebarInset's box, but as a div: the header is the banner, not
          part of <main>. */}
      <div className="relative flex w-full min-w-0 flex-1 flex-col bg-background">
        <header className="sticky top-0 z-[5] box-border flex h-[49px] items-center gap-[10px] border-0 border-b border-solid border-[var(--oa-divider)] bg-[var(--oa-chrome)] px-[var(--oa-space-5)] max-md:px-[var(--oa-space-3)]">
          <SidebarTrigger aria-label="Toggle navigation" />
          <TopBar me={me} />
        </header>
        <main id="oa-main" className="min-w-0 flex-1">
          <QuotaBanner />
          <CpuBanner role={me?.user.role} />
          <div className="oa-page">
            <Outlet />
          </div>
        </main>
      </div>
      {me && <DisplayNamePrompt key={me.user.id} me={me} />}
      <Toaster />
    </SidebarProvider>
  );
}

/** The daily quota is an expected state, so it gets its own copy. */
function LoadError({ quota }: { quota: boolean }) {
  const client = useQueryClient();
  return (
    <EdgePanel>
      {quota ? (
        <>
          <h1>Daily limit reached</h1>
          <p>
            This instance has used today's free-plan requests. Your artifacts
            are safe; try again after the reset.
          </p>
        </>
      ) : (
        <>
          <h1>Couldn't load your account</h1>
          <p>Something went wrong reaching the server.</p>
        </>
      )}
      <div className="oa-actions">
        <button
          type="button"
          className="oa-btn oa-primary"
          onClick={() => void client.refetchQueries({ queryKey: qk.me })}
        >
          Retry
        </button>
      </div>
    </EdgePanel>
  );
}

/** A router link that also closes the phone sheet. */
const useGo = () => {
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  return (e: MouseEvent, to: string) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    setOpenMobile(false);
    void navigate({ to });
  };
};

function Link({
  to,
  active,
  icon,
  label,
}: {
  to: string;
  active: boolean;
  icon: ReactNode;
  label: string;
}) {
  const go = useGo();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <a
          href={to}
          aria-current={active ? "page" : undefined}
          onClick={(e) => go(e, to)}
        >
          {icon}
          <span>{label}</span>
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function Sidebar({ me, path }: { me: Me | null; path: string }) {
  const role = me?.user.role;
  const guest = role === "guest";
  const on = (p: string) => path === p || path.startsWith(`${p}/`);
  const go = useGo();
  const home = guest ? "/shared" : "/";
  return (
    <ShSidebar>
      {/* One header-tall row (49px with its divider), so the sidebar's top
          lines up with the header. */}
      <SidebarHeader
        className="h-[49px] justify-center gap-0 border-b border-sidebar-border px-2 py-0"
        onClick={(e) => {
          if ((e.target as Element).closest("a")) go(e, home);
        }}
      >
        <SidebarBrand
          href={home}
          name={me?.instance.name || "Open Artifacts"}
        />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Primary">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {guest ? (
                  <Link
                    to="/shared"
                    active={on("/shared")}
                    icon={I.share}
                    label="Shared with me"
                  />
                ) : (
                  <>
                    <Link
                      to="/"
                      active={path === "/"}
                      icon={I.lib}
                      label="Library"
                    />
                    {me && (
                      <Link
                        to="/shared"
                        active={on("/shared")}
                        icon={I.share}
                        label="Shared with me"
                      />
                    )}
                    {me && (
                      <Link
                        to="/team"
                        active={on("/team")}
                        icon={I.team}
                        label="Team"
                      />
                    )}
                    {(role === "owner" || role === "admin") && (
                      <Link
                        to="/settings/usage"
                        active={on("/settings/usage")}
                        icon={I.usage}
                        label="Usage"
                      />
                    )}
                    {me && (
                      <Link
                        to="/settings/members"
                        active={
                          path.startsWith("/settings") && !on("/settings/usage")
                        }
                        icon={I.gear}
                        label="Settings"
                      />
                    )}
                  </>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
    </ShSidebar>
  );
}

function TopBar({ me }: { me: Me | null }) {
  const signOut = useSignOut();
  if (!me) return null;
  return (
    <>
      <SearchBox />
      <div
        style={{
          marginLeft: "auto",
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span>{me.user.email}</span>
        <Menu
          trigger={
            <Button
              variant="ghost"
              title="Account menu"
              style={{ padding: "0 2px" }}
            >
              {/* Named by hidden text, not aria-label, so the visible initials never contradict it. */}
              <span className="oa-sr">Account menu</span>
              <span aria-hidden="true" style={{ display: "contents" }}>
                <Avatar
                  name={me.user.name ?? undefined}
                  email={me.user.email}
                />
              </span>
            </Button>
          }
          items={[{ label: "Sign out", onSelect: signOut }]}
        />
      </div>
    </>
  );
}
