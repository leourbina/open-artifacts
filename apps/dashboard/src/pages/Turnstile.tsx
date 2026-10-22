import { type Ref, useEffect, useImperativeHandle, useRef } from "react";

/** Cloudflare Turnstile's script, loaded once per page. */
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";

/** The bits of the widget API this slot uses (see developers.cloudflare.com/turnstile). */
type TurnstileApi = {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId?: string) => void;
  remove?: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<void> | null = null;

/**
 * Injects Turnstile's script once and resolves when `window.turnstile` answers.
 * A page that already has the API (an inline widget) is left alone; a failed
 * load resolves too, so the slot just stays empty and the server's
 * `turnstile_required` copy talks the person through.
 */
const loadTurnstile = (): Promise<void> => {
  if (typeof window === "undefined" || window.turnstile)
    return Promise.resolve();
  loading ??= new Promise<void>((resolve) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
  return loading;
};

export type TurnstileHandle = {
  /** Clears the widget's token: every token is single-use. */
  reset: () => void;
};

/**
 * The code request's Turnstile slot. Renders nothing useful until the script
 * is in (or the page already loaded it), then hands every token to `onToken`
 * (`null` when the check fails or expires).
 */
export function Turnstile({
  siteKey,
  onToken,
  ref,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  ref?: Ref<TurnstileHandle>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  // The render options capture this ref, so a parent re-render never re-renders the widget.
  const emit = useRef(onToken);
  emit.current = onToken;

  useImperativeHandle(
    ref,
    () => ({
      reset: () => {
        if (id.current) window.turnstile?.reset(id.current);
      },
    }),
    [],
  );

  useEffect(() => {
    let live = true;
    void loadTurnstile().then(() => {
      const api = window.turnstile;
      if (!live || !api || !box.current) return;
      id.current = api.render(box.current, {
        sitekey: siteKey,
        action: "code_request",
        callback: (token: string) => emit.current(token),
        "error-callback": () => emit.current(null),
        "expired-callback": () => emit.current(null),
        "timeout-callback": () => emit.current(null),
      });
    });
    return () => {
      live = false;
      if (id.current && window.turnstile?.remove)
        window.turnstile.remove(id.current);
      id.current = null;
    };
  }, [siteKey]);

  return <div data-testid="turnstile" data-sitekey={siteKey} ref={box} />;
}
