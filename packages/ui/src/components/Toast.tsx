import { Toast as T } from "radix-ui";
import { useEffect, useState } from "react";
import { cx } from "./cx";
import s from "./Toast.module.css";

export type ToastOptions = {
  title: string;
  description?: string;
  tone?: "info" | "success" | "danger";
};
type Entry = ToastOptions & { id: number };

const MAX_VISIBLE = 3;
let nextId = 0;
let queue: Entry[] = [];
const listeners = new Set<(q: Entry[]) => void>();
const emit = () => {
  for (const l of listeners) l(queue);
};

/** Shows a toast in the mounted <Toaster />. */
export function toast(options: ToastOptions) {
  if (typeof window === "undefined") return; // SSR: nowhere to show it.
  queue = [...queue, { ...options, id: nextId++ }];
  while (queue.length > MAX_VISIBLE) {
    // The new toast always shows. Evict the oldest older non-danger toast,
    // or the oldest toast if every older one is danger.
    const i = queue.slice(0, -1).findIndex((t) => t.tone !== "danger");
    queue = queue.filter((_, j) => j !== Math.max(i, 0));
  }
  emit();
}

/** Clears every toast. For tests: the queue is module state. */
export function resetToasts() {
  queue = [];
  emit();
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
          className={cx(s.toast, s[t.tone ?? "info"])}
          onOpenChange={(open) => open || dismiss(t.id)}
        >
          <T.Title className={s.title}>{t.title}</T.Title>
          {t.description && (
            <T.Description className={s.description}>
              {t.description}
            </T.Description>
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
