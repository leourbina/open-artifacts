// Every dashboard toast, on Sonner (@oa/ui/shadcn). The Toaster's defaults
// are Design's (position, 5s, at most 3, close button, tone in the icon);
// here: 8s for errors and toasts with an action, and errors announced
// assertively (the title is an alert inside Sonner's polite region).
import { Toaster as Sonner, toast as sonner } from "@oa/ui/shadcn";
import type { ReactNode } from "react";

export type ToastOptions = {
  title: string;
  description?: ReactNode;
  tone?: "info" | "success" | "danger";
  /** A button in the toast, e.g. Undo. Clicking it also dismisses. */
  action?: { label: string; onClick(): void };
};

const LONG = 8000;

export function toast({ title, description, tone, action }: ToastOptions) {
  const danger = tone === "danger";
  const opts = {
    description,
    duration: danger || action ? LONG : undefined,
    action: action && { label: action.label, onClick: () => action.onClick() },
  };
  if (danger) return sonner.error(<span role="alert">{title}</span>, opts);
  if (tone === "success") return sonner.success(title, opts);
  return sonner.info(title, opts);
}

/** The app's one Toaster. The close button is named "Dismiss", with a 24px
    hit area and the 2px focus ring. */
export function Toaster() {
  return (
    <Sonner
      toastOptions={{
        closeButtonAriaLabel: "Dismiss",
        classNames: {
          closeButton:
            "size-6! focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
        },
      }}
    />
  );
}
