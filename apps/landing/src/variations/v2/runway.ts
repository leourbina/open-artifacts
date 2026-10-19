// The runway calculator in figure 1. Shared by the build (first paint) and the
// page script (live updates). Amounts are in thousands of dollars.
export const MONTHS = 24;

export interface Runway {
  /** Cash at the end of each month, clamped at zero. */
  series: number[];
  /** Month the cash runs out, or 0 if it never does within MONTHS. */
  out: number;
  /** First month revenue covers burn, or 0 if it doesn't within MONTHS. */
  even: number;
}

export function runway(
  cash: number,
  burn: number,
  rev: number,
  growth: number,
): Runway {
  const series: number[] = [];
  let out = 0;
  let even = 0;
  for (let m = 1; m <= MONTHS; m++) {
    const r = rev * (1 + growth / 100) ** m;
    if (!even && r >= burn) even = m;
    cash += r - burn;
    if (cash <= 0 && !out) out = m;
    series.push(Math.max(0, cash));
  }
  return { series, out, even };
}

export const money = (k: number) =>
  k >= 1000 ? `$${(k / 1000).toFixed(k % 1000 ? 1 : 0)}M` : `$${k}k`;

export const verdict = ({ out, even }: Runway) =>
  out
    ? `${out} months of runway`
    : even
      ? "Default alive"
      : `More than ${MONTHS} months`;

export const detail = ({ out, even }: Runway) =>
  even && !out
    ? `Revenue covers burn in month ${even}, before the cash runs out.`
    : out
      ? `The cash runs out in month ${out}${even ? `, after revenue covers burn in month ${even}` : ""}.`
      : `Revenue stays below burn for all ${MONTHS} months.`;
