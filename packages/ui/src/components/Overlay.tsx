import { Dialog as D, DropdownMenu as M, Tabs as T } from "radix-ui";
import { Fragment, type ReactNode, useRef, useState } from "react";
import { cx } from "./cx";
import { useDevError } from "./dev";
import s from "./Overlay.module.css";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  // Controlled dialogs have no Radix Trigger, so restore focus ourselves.
  const opener = useRef<HTMLElement | null>(null);
  useDevError(!title.trim(), "Dialog needs a non-empty `title`");
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={s.overlay} />
        {/* Radix warns unless aria-describedby is explicitly undefined. */}
        <D.Content
          className={s.dialog}
          onOpenAutoFocus={() => {
            opener.current = document.activeElement as HTMLElement | null;
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            opener.current?.focus();
          }}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <D.Title className={s.title}>{title}</D.Title>
          {description && (
            <D.Description className={s.description}>
              {description}
            </D.Description>
          )}
          {children}
          {footer && <div className={s.footer}>{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export type MenuItem =
  | { label: string; onSelect: () => void; danger?: boolean; icon?: ReactNode }
  | "separator";

export function Menu({
  trigger,
  items,
}: {
  trigger: ReactNode;
  items: MenuItem[];
}) {
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content className={s.menu} align="end" sideOffset={4}>
          {items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items are positional; labels may repeat
            <Fragment key={i}>
              {item === "separator" ? (
                <M.Separator className={s.separator} />
              ) : (
                <M.Item
                  onSelect={item.onSelect}
                  data-danger={item.danger || undefined}
                  className={cx(s.item, item.danger && s.danger)}
                >
                  {item.icon}
                  {item.label}
                </M.Item>
              )}
            </Fragment>
          ))}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

/**
 * Radix values are tab indices, so Radix's element ids are its useId() plus
 * the index: valid IDREFs whatever the caller's ids contain, even repeats.
 */
export function Tabs({
  tabs,
  value,
  onValueChange,
}: {
  tabs: { id: string; label: ReactNode; content: ReactNode }[];
  value?: string;
  onValueChange?: (id: string) => void;
}) {
  useDevError(
    new Set(tabs.map((t) => t.id)).size !== tabs.length,
    "Tabs ids must be unique",
    "warn",
  );
  // Uncontrolled selection is tracked by id, so it follows inserted tabs.
  const [inner, setInner] = useState(tabs[0]?.id);
  const current = value ?? inner;
  // An unknown id falls back to the first tab.
  const index = Math.max(
    tabs.findIndex((t) => t.id === current),
    0,
  );
  return (
    <T.Root
      value={String(index)}
      onValueChange={(v) => {
        const tab = tabs[Number(v)];
        if (!tab) return;
        setInner(tab.id);
        onValueChange?.(tab.id);
      }}
    >
      <T.List className={s.tabs}>
        {tabs.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ids may repeat
          <T.Trigger key={i} value={String(i)} className={s.tab}>
            {t.label}
          </T.Trigger>
        ))}
      </T.List>
      {tabs.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ids may repeat
        <T.Content key={i} value={String(i)} className={s.panel}>
          {t.content}
        </T.Content>
      ))}
    </T.Root>
  );
}
