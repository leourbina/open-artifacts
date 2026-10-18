import { useNavigate } from "@tanstack/react-router";
import type { ComponentProps } from "react";

/** Client-side navigation for paths the typed route tree doesn't enumerate. */
export function AppLink({
  href,
  onClick,
  target,
  download,
  ...rest
}: ComponentProps<"a"> & { href: string }) {
  const navigate = useNavigate();
  return (
    // biome-ignore lint/a11y/useAnchorContent: children come through rest
    <a
      {...rest}
      href={href}
      target={target}
      download={download}
      onClick={(e) => {
        onClick?.(e);
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey ||
          (target && target !== "_self") ||
          download !== undefined
        )
          return;
        e.preventDefault();
        void navigate({ to: href } as never);
      }}
    />
  );
}
