import { Dialog as D } from "radix-ui";
import {
  type AnchorHTMLAttributes,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { Button, IconButton } from "./Button";
import { cx } from "./cx";
import s from "./Layout.module.css";

const glyph = (d: string) => (
  <svg viewBox="0 0 16 16" className={s.glyph} aria-hidden="true">
    <path d={d} />
  </svg>
);

export function Banner({
  tone,
  title,
  children,
  action,
  icon,
  compact = false,
  onDismiss,
}: {
  tone: "info" | "success" | "warning" | "danger";
  /** Omit for a single-line notice such as the viewer strip. */
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  /** Decorative; rendered aria-hidden before the text. */
  icon?: ReactNode;
  /** Tighter padding for a one-line strip. */
  compact?: boolean;
  onDismiss?: () => void;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx(s.banner, s[tone], compact && s.compact)}
    >
      {icon && (
        <span className={s.bannerIcon} aria-hidden="true">
          {icon}
        </span>
      )}
      <div className={s.bannerText}>
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action}
      {onDismiss && (
        <IconButton
          label="Dismiss"
          size="sm"
          icon={glyph("M4 4l8 8M12 4l-8 8")}
          onClick={onDismiss}
        />
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={s.empty}>
      <div className={s.emptyIcon}>{icon}</div>
      <h2 className={s.emptyTitle}>{title}</h2>
      <p className={s.emptyDescription}>{description}</p>
      {action}
    </div>
  );
}

export function NavItem({
  href,
  icon,
  label,
  count,
  active = false,
  className,
  ...rest
}: {
  href: string;
  icon?: ReactNode;
  label: ReactNode;
  count?: number;
  active?: boolean;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(s.navItem, className)}
      {...rest}
    >
      {icon}
      <span className={s.navLabel}>{label}</span>
      {count !== undefined && (
        <>
          <span className={s.navCount} aria-hidden="true">
            {count}
          </span>
          <span className={s.srOnly}>, {count} items</span>
        </>
      )}
    </a>
  );
}

const WIDE = "(min-width: 960px)";

/** Sidebar at ≥ 960px; below that the nav moves into a drawer. */
export function AppShell({
  nav,
  header,
  children,
}: {
  nav: ReactNode;
  header?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const wide = () =>
      window.matchMedia
        ? window.matchMedia(WIDE).matches
        : window.innerWidth >= 960;
    const close = () => wide() && setOpen(false);
    const mq = window.matchMedia?.(WIDE);
    if (mq) {
      mq.addEventListener("change", close);
      return () => mq.removeEventListener("change", close);
    }
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [open]);
  return (
    <div className={s.shell}>
      <a href="#oa-main" className={s.skip}>
        Skip to content
      </a>
      <aside className={s.side}>
        <nav aria-label="Primary">{nav}</nav>
      </aside>
      <div className={s.column}>
        <header className={s.top}>
          <D.Root open={open} onOpenChange={setOpen}>
            <D.Trigger asChild>
              <IconButton
                label="Open navigation"
                icon={glyph("M2 4h12M2 8h12M2 12h12")}
                className={s.menuButton}
              />
            </D.Trigger>
            <D.Portal>
              <D.Overlay className={s.overlay} />
              <D.Content className={s.drawer} aria-describedby={undefined}>
                <div className={s.drawerHead}>
                  <D.Title className={s.drawerTitle}>Navigation</D.Title>
                  <D.Close asChild>
                    {/* No tooltip: it would take focus on open and eat Escape. */}
                    <Button
                      variant="ghost"
                      aria-label="Close navigation"
                      icon={glyph("M4 4l8 8M12 4l-8 8")}
                      className={s.close}
                    />
                  </D.Close>
                </div>
                {/* Following a link closes the drawer; new-tab clicks don't.
                    Enter on a link also fires click, so no key handler. */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: delegated link clicks */}
                <nav
                  aria-label="Primary"
                  onClick={(e) => {
                    // defaultPrevented still closes: router <Link>s prevent it.
                    const plain =
                      e.button === 0 &&
                      !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
                    if (plain && (e.target as Element).closest("a")) {
                      setOpen(false);
                    }
                  }}
                >
                  {nav}
                </nav>
              </D.Content>
            </D.Portal>
          </D.Root>
          {header}
        </header>
        <main id="oa-main" className={s.main}>
          {children}
        </main>
      </div>
    </div>
  );
}
