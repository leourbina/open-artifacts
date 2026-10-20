// A controlled shadcn dialog: title, description, body and footer, with
// focus returned to whatever opened it (there is no Radix Trigger).
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@oa/ui/shadcn";
import { type ReactNode, useRef } from "react";

/** Header, body and footer of a dialog. */
export function Modal({
  open = true,
  onClose,
  title,
  description,
  footer,
  children,
}: {
  open?: boolean;
  onClose: () => void;
  title: string;
  description: string;
  footer: ReactNode;
  children?: ReactNode;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="gap-[var(--oa-space-4)] sm:max-w-[440px]"
        // No Radix Trigger (the dialog is controlled), so put focus back on
        // whatever opened it, as a trigger would.
        onOpenAutoFocus={() => {
          opener.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-[length:var(--oa-text-lg)]">
            {title}
          </DialogTitle>
          <DialogDescription className="text-[length:var(--oa-text-sm)]">
            {description}
          </DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
