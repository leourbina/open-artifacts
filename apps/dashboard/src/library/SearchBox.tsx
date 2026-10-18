import { Input } from "@oa/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const SEARCH_DEBOUNCE_MS = 250;

export function SearchBox() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onSearch = pathname === "/search";
  const urlQ = useRouterState({
    select: (s) =>
      s.location.pathname === "/search"
        ? (new URLSearchParams(s.location.searchStr).get("q") ?? "")
        : "",
  });
  const [value, setValue] = useState(urlQ);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const input = useRef<HTMLInputElement>(null);
  // Don't clobber what's being typed when the URL syncs back.
  useEffect(() => {
    if (document.activeElement !== input.current) setValue(urlQ);
  }, [urlQ]);
  // A pending search must not hijack a later navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on route change only
  useEffect(() => () => clearTimeout(timer.current), [pathname]);
  const go = (search: object) =>
    void navigate({ to: "/search", search, replace: onSearch } as never);
  return (
    <Input
      ref={input}
      type="search"
      aria-label="Search artifacts"
      placeholder="Search titles, content, and agents"
      value={value}
      onChange={(e) => {
        const q = e.target.value;
        setValue(q);
        clearTimeout(timer.current);
        if (!q.trim()) {
          if (onSearch) go({});
          return;
        }
        timer.current = setTimeout(() => go({ q }), SEARCH_DEBOUNCE_MS);
      }}
    />
  );
}
