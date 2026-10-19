import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps, toast } from "sonner";
import { useDataTheme } from "#shadcn/hooks/use-data-theme";

const Toaster = ({ ...props }: ToasterProps) => {
  // Ours: follows <html data-theme> instead of next-themes.
  const theme = useDataTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      // Studio defaults: bottom-right, 16px in (full width below 600px, above
      // the home indicator), 5s (pass duration: 8000 for errors and toasts
      // with an action), at most 3 visible, a close button on each. Tone
      // lives in the icon only.
      position="bottom-right"
      duration={5000}
      visibleToasts={3}
      offset={16}
      mobileOffset={{
        bottom: "calc(16px + env(safe-area-inset-bottom))",
        left: 16,
        right: 16,
      }}
      closeButton
      icons={{
        success: <CircleCheckIcon className="size-4 text-(--oa-success-fg)" />,
        info: <InfoIcon className="size-4 text-(--oa-accent-fg)" />,
        warning: <TriangleAlertIcon className="size-4 text-(--oa-warning)" />,
        error: <OctagonXIcon className="size-4 text-(--oa-danger)" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster, toast };
