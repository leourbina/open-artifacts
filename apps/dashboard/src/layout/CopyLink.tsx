import { Button, Input } from "@oa/ui/shadcn";
import { useEffect, useState } from "react";
import { toast } from "./toast";

/** Shows `link` in a read-only field with a Copy link button. */
export function CopyLink({
  link,
  label = "Link",
}: {
  link: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    const failed = () =>
      toast({
        title: "Couldn't copy",
        description: "Select it and copy it yourself.",
        tone: "danger",
      });
    if (!navigator.clipboard) return failed();
    navigator.clipboard.writeText(link).then(() => setCopied(true), failed);
  };
  return (
    <div className="flex min-w-0 items-center gap-[var(--oa-space-2)]">
      <Input
        readOnly
        aria-label={label}
        value={link}
        onFocus={(e) => e.currentTarget.select()}
        className="h-[30px] min-w-0 flex-1 font-mono text-[length:var(--oa-text-xs)] md:text-[length:var(--oa-text-xs)]"
      />
      <Button
        variant="outline"
        size="sm"
        className="h-[30px] flex-none text-[length:var(--oa-text-sm)]"
        onClick={copy}
      >
        {copied ? "✓ Copied" : "Copy link"}
      </Button>
    </div>
  );
}
