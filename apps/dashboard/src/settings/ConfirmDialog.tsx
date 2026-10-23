// A controlled confirm (Radix alert dialog): Cancel, or the one action.
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@oa/ui/shadcn";
import { type ReactNode, useRef } from "react";

export function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirm,
  danger,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: ReactNode;
  confirm: string;
  /** The action destroys something: the danger button. */
  danger?: boolean;
  onConfirm: () => void;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent
        className="gap-[var(--oa-space-4)] sm:max-w-[440px]"
        // Controlled, with no Radix Trigger: put focus back on whatever opened it.
        onOpenAutoFocus={() => {
          opener.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[length:var(--oa-text-lg)]">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-[var(--oa-space-2)] text-[length:var(--oa-text-sm)] text-foreground">
              {body}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant={danger ? "destructive" : "default"}
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
