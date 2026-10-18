import { Tooltip as T } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import s from "./Tooltip.module.css";

export function Tooltip({
  content,
  children,
}: {
  content: ReactNode;
  children: ReactElement;
}) {
  return (
    <T.Provider delayDuration={400}>
      <T.Root>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          <T.Content className={s.tip} sideOffset={6}>
            {content}
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
