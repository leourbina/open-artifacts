import { Toast as T } from "radix-ui";
import { useEffect, useState } from "react";
import { cx } from "./cx";
import { isDev } from "./dev";
import s from "./Toast.module.css";

export type ToastOptions = {
  title: string;
  description?: string;
  tone?: "info" | "success" | "danger";
  /** A button in the toast, e.g. Undo. Clicking it also dismisses. */
  action?: { label: string; onClick(): void; altText?: string };
};
type Entry = ToastOptions & { id: number };

const MAX_VISIBLE = 3;
// Long enough to reach the action (e.g. Undo); Radix's default is 5s.
const ACTION_DURATION = 8000;
let nextId = 0;
let queue: Entry[] = [];
const listeners = new Set<(q: Entry[]) => void>();
const emit = () => {
  for (const l of listeners) l(queue);
};

/** Shows a toast in the mounted <Toaster />. */
export function toast(options: ToastOptions) {
  if (typeof window === "undefined") return; // SSR: nowhere to show it.
  let entry: Entry = { ...options, id: nextId++ };
  if (entry.action && !entry.action.label.trim()) {
    // A blank label would be an unnamed button: show the toast without it.
    if (isDev()) console.error("toast() action needs a non-empty `label`");
    entry = { ...entry, action: undefined };
  }
  queue = [...queue, entry];
  while (queue.length > MAX_VISIBLE) {
    // The new toast always shows. Among older toasts, evict the oldest plain
    // one, then the oldest danger one without an action, then the oldest.
    const older = queue.slice(0, -1);
    let i = older.findIndex((t) => !t.action && t.tone !== "danger");
    if (i < 0) i = older.findIndex((t) => !t.action);
    queue = queue.filter((_, j) => j !== Math.max(i, 0));
  }
  emit();
}

/** Clears every toast. For tests: the queue is module state. */
export function resetToasts() {
  queue = [];
  emit();
}

/** Reports an error as uncaught without interrupting the caller. */
function rethrowLater(error: unknown) {
  if (typeof reportError === "function") return reportError(error);
  // No reportError (e.g. jsdom): let window "error" listeners handle it,
  // and throw from a microtask only if none did.
  const event = new ErrorEvent("error", { error, cancelable: true });
  if (window.dispatchEvent(event))
    queueMicrotask(() => {
      throw error;
    });
}

export function Toaster() {
  const [entries, setEntries] = useState(queue);
  useEffect(() => {
    listeners.add(setEntries);
    return () => {
      listeners.delete(setEntries);
    };
  }, []);
  const dismiss = (id: number) => {
    queue = queue.filter((t) => t.id !== id);
    emit();
  };
  return (
    <T.Provider swipeDirection="right">
      {entries.map((t) => (
        <T.Root
          key={t.id}
          type={t.tone === "danger" ? "foreground" : "background"}
          duration={t.action ? ACTION_DURATION : undefined}
          className={cx(s.toast, s[t.tone ?? "info"])}
          onOpenChange={(open) => open || dismiss(t.id)}
        >
          <T.Title className={s.title}>{t.title}</T.Title>
          {t.description && (
            <T.Description className={s.description}>
              {t.description}
            </T.Description>
          )}
          {t.action && (
            <T.Action
              altText={t.action.altText ?? t.action.label}
              className={s.action}
              onClick={() => {
                // Radix closes the toast after this handler, so a throwing
                // onClick must not stop it. Report the error as uncaught
                // (window "error" event) instead of swallowing it.
                try {
                  t.action?.onClick();
                } catch (error) {
                  rethrowLater(error);
                }
              }}
            >
              {t.action.label}
            </T.Action>
          )}
          <T.Close className={s.close} aria-label={`Dismiss: ${t.title}`}>
            ×
          </T.Close>
        </T.Root>
      ))}
      <T.Viewport className={s.viewport} />
    </T.Provider>
  );
}
