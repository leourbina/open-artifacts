import { relativeTime } from "../library/time";

const WEEK = 7 * 86_400_000;
const sameYear = (d: Date, now: number) =>
  d.getFullYear() === new Date(now).getFullYear();

/** "2 hours ago", "yesterday" under a week; then "Oct 12" (", 2025" if not this year). */
export function versionDate(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (now - d.getTime() < WEEK) return relativeTime(iso, now);
  return d.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(sameYear(d, now) ? {} : { year: "numeric" }),
  });
}

/** "October 22 at 3:10 PM" (", 2025" before "at" if not this year): tooltips and row names. */
export function exactDate(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString("en", {
    month: "long",
    day: "numeric",
    ...(sameYear(d, now) ? {} : { year: "numeric" }),
  });
  const time = d.toLocaleTimeString("en", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day} at ${time}`;
}
