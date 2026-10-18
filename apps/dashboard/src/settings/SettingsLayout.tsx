import type { Role } from "@oa/shared";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { useMe } from "../auth/useMe";
import { AppLink } from "../library/AppLink";
import "./settings.css";

const TABS: { to: string; label: string; roles: Role[] }[] = [
  { to: "/settings/members", label: "Members", roles: ["owner", "admin"] },
  {
    to: "/settings/agents",
    label: "Agents",
    roles: ["owner", "admin", "member"],
  },
  { to: "/settings/instance", label: "Instance", roles: ["owner", "admin"] },
];

export function SettingsLayout() {
  const state = useMe();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const role = state.status === "authed" ? state.me.user.role : null;
  return (
    <div className="oa-settings">
      <h1>Settings</h1>
      <nav className="oa-settings-tabs" aria-label="Settings sections">
        {TABS.filter((t) => role && t.roles.includes(role)).map((t) => (
          <AppLink
            key={t.to}
            href={t.to}
            aria-current={path === t.to ? "page" : undefined}
          >
            {t.label}
          </AppLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

/** Role gate: renders `children` for `allow`, else redirects per `redirects` (default `/shared`). */
export function Gate({
  allow,
  redirects,
  children,
}: {
  allow: Role[];
  redirects: Partial<Record<Role, string>>;
  children: ReactNode;
}) {
  const state = useMe();
  const role = state.status === "authed" ? state.me.user.role : null;
  const to = role && !allow.includes(role) ? (redirects[role] ?? "/") : null;
  useRedirectEffect(to);
  return role && !to ? <>{children}</> : null;
}

function useRedirectEffect(to: string | null) {
  const navigate = useNavigate();
  useEffect(() => {
    if (to) void navigate({ to: to as string, replace: true });
  }, [to, navigate]);
}
