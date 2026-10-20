import type { Me } from "@oa/shared";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@oa/ui/shadcn";
import { useState } from "react";
import { useUpdateMe } from "../api/queries";
import { useSingleFlight } from "../api/useSingleFlight";
import {
  NAME_MAX,
  nameLength,
  nameOk,
  saveError,
  TOO_LONG,
} from "../auth/displayName";

/** "Not now" lasts for this browser session, per user. */
const skipKey = (userId: string) => `oa:display-name-skipped:${userId}`;
const skipped = (userId: string) => {
  try {
    return sessionStorage.getItem(skipKey(userId)) === "1";
  } catch {
    return false;
  }
};
const remember = (userId: string) => {
  try {
    sessionStorage.setItem(skipKey(userId), "1");
  } catch {
    // Storage blocked: the dialog just comes back on the next load.
  }
};

/** Asks for a display name while the server says the user needs one. Key it by user id. */
export function DisplayNamePrompt({ me }: { me: Me }) {
  const userId = me.user.id;
  const [dismissed, setDismissed] = useState(() => skipped(userId));
  const [name, setName] = useState(me.suggestedName ?? "");
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateMe();
  const once = useSingleFlight();
  const open = me.needsDisplayName && !dismissed;
  const trimmed = name.trim();
  const tooLong = nameLength(trimmed) > NAME_MAX;
  const notNow = () => {
    remember(userId);
    setDismissed(true);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && notNow()}>
      <DialogContent
        showCloseButton={false}
        className="bg-card sm:max-w-sm"
        // Escape and "Not now" dismiss; a stray click on the backdrop doesn't.
        onInteractOutside={(e) => e.preventDefault()}
        // Nothing opened it, so focus the page heading rather than <body>.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          // Two queries: "main h1, main" would match <main> first (document order).
          const to =
            document.querySelector<HTMLElement>("main h1") ??
            document.querySelector<HTMLElement>("main");
          if (!to) return;
          if (!to.hasAttribute("tabindex")) to.tabIndex = -1;
          to.focus();
        }}
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!nameOk(trimmed) || update.isPending) return;
            setError(null);
            once((done) =>
              update.mutate(
                { displayName: trimmed },
                { onError: (err) => setError(saveError(err)), onSettled: done },
              ),
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>What do you like to be called?</DialogTitle>
            <DialogDescription>
              Teammates see this name on invites and shared artifacts.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="oa-display-name">Your name</Label>
            <Input
              id="oa-display-name"
              value={name}
              placeholder="Your full name"
              autoComplete="name"
              aria-invalid={Boolean(error || tooLong) || undefined}
              aria-describedby={
                error || tooLong ? "oa-display-name-err" : undefined
              }
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
            {(error || tooLong) && (
              <p
                id="oa-display-name-err"
                role="alert"
                className="text-sm text-destructive"
              >
                {error ?? TOO_LONG}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={notNow}>
              Not now
            </Button>
            <Button
              type="submit"
              disabled={!nameOk(trimmed) || update.isPending}
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
