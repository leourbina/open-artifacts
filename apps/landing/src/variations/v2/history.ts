// Figure 3: four versions of one memo, each from a different agent. The word
// diffs are built here at build time, so the page script only toggles panels.
export interface Version {
  v: number;
  agent: string;
  when: string;
  note: string;
  body: [string, string];
}

const p1 =
  "We move the events table from Postgres to D1 in three steps: dual-write for a week, backfill 90 days, then switch reads.";
const p2 =
  "Priya owns the cutover. Postgres stays as a read-only fallback for a month. Cutover is planned for November 7.";
const risk =
  " Backfill is the slow part: at 40k rows a minute, 90 days takes about six hours.";

export const versions: Version[] = [
  {
    v: 1,
    agent: "Claude Code",
    when: "Mon 09:12",
    note: "First draft",
    body: [
      "We move the events table from Postgres to D1 in three steps. First we dual-write for a week, then we backfill the last 90 days, and finally we switch reads over.",
      "Postgres stays as a read-only fallback for a month. Cutover is planned for November 7.",
    ],
  },
  {
    v: 2,
    agent: "Cursor",
    when: "Mon 11:40",
    note: "Tightened, named an owner",
    body: [p1, p2],
  },
  {
    v: 3,
    agent: "Codex",
    when: "Tue 10:05",
    note: "Added the backfill risk",
    body: [p1 + risk, p2],
  },
  {
    v: 4,
    agent: "Claude Code",
    when: "Wed 16:22",
    note: "Moved the date after review",
    body: [
      p1 + risk,
      "Priya owns the cutover. Postgres stays as a read-only fallback for a month. Cutover moves to November 14, after the billing freeze.",
    ],
  },
];

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Word-level diff of a against b as HTML with <del> and <ins> runs. */
export function diff(a: string, b: string): string {
  const A = a.match(/\S+\s*/g) ?? [];
  const B = b.match(/\S+\s*/g) ?? [];
  const dp = A.map(() => new Array<number>(B.length + 1).fill(0));
  dp.push(new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      dp[i][j] =
        A[i] === B[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: [string, string][] = [];
  const push = (t: string, s: string) => {
    const last = ops[ops.length - 1];
    if (last && last[0] === t) last[1] += s;
    else ops.push([t, s]);
  };
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      push("=", A[i++]);
      j++;
    } else if (j >= B.length || (i < A.length && dp[i + 1][j] >= dp[i][j + 1]))
      push("del", A[i++]);
    else push("ins", B[j++]);
  }
  return ops
    .map(([t, s]) => (t === "=" ? esc(s) : `<${t}>${esc(s)}</${t}>`))
    .join("");
}
