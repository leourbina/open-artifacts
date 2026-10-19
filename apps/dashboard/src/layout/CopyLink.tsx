import { Button, Input, toast } from "@oa/ui";
import { useEffect, useState } from "react";

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
        description: "Copy it by hand.",
        tone: "danger",
      });
    if (!navigator.clipboard) return failed();
    navigator.clipboard.writeText(link).then(() => setCopied(true), failed);
  };
  return (
    <div className="oa-copylink">
      <Input
        readOnly
        aria-label={label}
        value={link}
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button onClick={copy}>{copied ? "\u2713 Copied" : "Copy link"}</Button>
    </div>
  );
}
