// Shared shadcn layout for the settings cards (Design: cards pad 20px,
// 16px at <= 600px; 12px from header to body; 16px between cards).
import { Card, CardContent, CardHeader, CardTitle } from "@oa/ui/shadcn";
import type { ReactNode } from "react";

/** The card: its vertical padding and the header-to-body gap. */
export const CARD =
  "gap-[var(--oa-space-3)] py-[var(--oa-space-5)] shadow-none max-[600px]:py-[var(--oa-space-4)]";
/** The card's horizontal padding, on its header, content and footer. */
export const INSET =
  "px-[var(--oa-space-5)] max-[600px]:px-[var(--oa-space-4)]";
/** One vertical rhythm inside a card. */
export const GAP = "gap-[var(--oa-space-3)]";
/** Cards stack 16px apart. */
export const STACK = "grid min-w-0 grid-cols-1 gap-[var(--oa-space-4)]";

export const muted =
  "m-0 text-[length:var(--oa-text-xs)] text-muted-foreground";
export const errorText = "m-0 text-[length:var(--oa-text-sm)] text-destructive";

export function SettingsCard({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <Card className={CARD}>
        <CardHeader
          className={`flex min-h-[30px] items-center justify-between ${GAP} ${INSET}`}
        >
          <CardTitle>
            <h2
              id={id}
              className="m-0 text-[length:var(--oa-text-md)] font-semibold"
            >
              {title}
            </h2>
          </CardTitle>
          {action}
        </CardHeader>
        <CardContent className={`grid min-w-0 ${GAP} ${INSET}`}>
          {children}
        </CardContent>
      </Card>
    </section>
  );
}
