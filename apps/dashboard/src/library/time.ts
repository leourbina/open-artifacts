const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3600],
  ["minute", 60],
];
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function relativeTime(iso: string, now = Date.now()): string {
  const secs = (Date.parse(iso) - now) / 1000;
  if (Number.isNaN(secs)) return "";
  for (const [unit, size] of UNITS)
    if (Math.abs(secs) >= size)
      return rtf.format(Math.trunc(secs / size), unit);
  return "just now";
}
