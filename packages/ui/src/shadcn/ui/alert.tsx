import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type * as React from "react";

// On a tone's soft fill, --input edges drop below 3:1; outline controls
// inside use the muted ink instead (>= 3:1 on every soft fill).
const toneEdges = "[&_[data-variant=outline]]:border-muted-foreground";

const alertVariants = cva(
  [
    "relative grid w-full grid-cols-[0_1fr_auto] items-center gap-y-0.5 rounded-lg border px-4 py-2 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*7)_1fr_auto] [&>svg]:size-4 [&>svg]:text-current",
    // The action spans the title and text rows only when there is a title;
    // otherwise an empty second row would push one-line text above center.
    "has-[>[data-slot=alert-title]]:*:data-[slot=alert-action]:row-[1/span_2]",
  ],
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 [&>svg]:text-current",
        // Ours: the Studio banner tones, a soft fill with ink text.
        info: `${toneEdges} border-transparent bg-brand-soft text-foreground *:data-[slot=alert-description]:text-foreground`,
        success: `${toneEdges} border-transparent bg-success-soft text-foreground *:data-[slot=alert-description]:text-foreground`,
        warning: `${toneEdges} border-transparent bg-warning-soft text-foreground *:data-[slot=alert-description]:text-foreground`,
        danger: `${toneEdges} border-transparent bg-danger-soft text-foreground *:data-[slot=alert-description]:text-foreground`,
      },
      size: {
        default: "",
        // A one-line strip (the viewer notice); room for an icon button.
        sm: "py-1 ps-3 pe-1",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Alert({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      // Only failures interrupt; every other tone is a polite status.
      role={
        variant === "danger" || variant === "destructive" ? "alert" : "status"
      }
      className={cn(alertVariants({ variant, size }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 min-h-4 font-medium tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

// Ours: a trailing slot (a button, a dismiss) beside the title and text.
function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn(
        "col-start-3 row-start-1 flex items-center gap-2 ps-3",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertAction, AlertDescription, AlertTitle, alertVariants };
