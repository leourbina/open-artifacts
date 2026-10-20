// Exit 0 and print `release-only` when every file changed between BASE and HEAD
// (merge-base diff, so a branch behind its base is judged by its own changes)
// is part of a release-please release PR; otherwise exit 1 naming the first
// offender. Usage: node --experimental-strip-types scripts/ci/release-only.ts BASE HEAD
import { execFileSync } from "node:child_process";

const [base, head] = process.argv.slice(2);

const git = (args: string[]): Buffer =>
  execFileSync("git", args, { maxBuffer: 256 * 1024 * 1024 });

const fail = (path: string, reason: string): never => {
  console.log(`${path}: ${reason}`);
  process.exit(1);
};

if (!base || !head) {
  console.log("usage: release-only.ts BASE HEAD");
  process.exit(1);
}

let mergeBase: string;
let raw: string[];
try {
  mergeBase = git(["merge-base", base, head]).toString().trim();
  raw = git([
    "diff",
    "--name-status",
    "-z",
    "-M",
    "--no-ext-diff",
    `${mergeBase}`,
    head,
  ])
    .toString()
    .split("\0");
} catch {
  console.log(
    `cannot diff ${base}...${head} (unknown commit or no merge base)`,
  );
  process.exit(1);
}

const show = (rev: string, path: string): string =>
  git(["show", `${rev}:${path}`]).toString("utf8");

/** package.json may change only its top-level "version". */
function versionOnly(path: string): string | undefined {
  let a: Record<string, unknown>;
  let b: Record<string, unknown>;
  try {
    a = JSON.parse(show(mergeBase, path));
    b = JSON.parse(show(head, path));
  } catch {
    return "is not valid JSON on both sides";
  }
  if (typeof a !== "object" || typeof b !== "object" || !a || !b)
    return "is not a JSON object";
  delete a.version;
  delete b.version;
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
    ? undefined
    : 'changes something other than "version"';
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  return v;
}

// -z name-status: STATUS NUL PATH NUL, and for R/C: STATUS NUL OLD NUL NEW NUL.
for (let i = 0; i < raw.length && raw[i] !== ""; ) {
  const status = raw[i++] as string;
  const first = raw[i++] as string;
  if (status.startsWith("R") || status.startsWith("C")) {
    const second = raw[i++] as string;
    fail(second, `renamed or copied from ${first}`);
  }
  if (status === "D") fail(first, "deleted");
  if (status !== "M" && status !== "A")
    fail(first, `unsupported change (${status})`);
  if (first === "CHANGELOG.md" || first === ".release-please-manifest.json")
    continue;
  if (first === "package.json" || first.endsWith("/package.json")) {
    if (status !== "M") fail(first, "is a new package.json");
    const why = versionOnly(first);
    if (why) fail(first, why);
    continue;
  }
  fail(first, "is not a release file");
}

console.log("release-only");
