// After a release deploys: prod /healthz and the landing's oa-version meta must
// both show the released version, else open a `blocker` issue and fail.
// Usage: node --experimental-strip-types scripts/ci/verify-release.ts --tag vX.Y.Z --repo owner/name [--demo-url URL]
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PROD = "https://artifacts.leourbina.com";
const SITE = "https://open-artifacts.com/";
const TIMEOUT_MS = 180_000;
const INTERVAL_MS = 10_000;

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
  cmd: string,
  args: string[],
) => ExecResult | Promise<ExecResult>;

type Deps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/** The `oa-version` meta tag's content, whatever the attribute order. */
function metaVersion(html: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bname\s*=\s*["']oa-version["']/i.test(tag)) continue;
    return tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
  }
  return null;
}

async function healthVersion(
  d: Deps,
  base: string,
  label: string,
  want: string,
): Promise<string | undefined> {
  let res: Response;
  try {
    res = await d.fetch(`${base}/healthz`);
  } catch (e) {
    return `${label} healthz unreachable (${(e as Error).message})`;
  }
  if (!res.ok) return `${label} healthz answered HTTP ${res.status}`;
  let version: unknown;
  try {
    version = ((await res.json()) as { version?: unknown }).version;
  } catch {
    return `${label} healthz did not answer JSON`;
  }
  return version === want
    ? undefined
    : `${label} healthz reports ${typeof version === "string" ? version : "no version"}, expected ${want}`;
}

async function landingVersion(
  d: Deps,
  want: string,
): Promise<string | undefined> {
  let res: Response;
  try {
    res = await d.fetch(SITE);
  } catch (e) {
    return `landing unreachable (${(e as Error).message})`;
  }
  if (!res.ok) return `landing answered HTTP ${res.status}`;
  const v = metaVersion(await res.text());
  if (v === null) return "landing has no oa-version meta tag";
  return v === want
    ? undefined
    : `landing oa-version is ${v}, expected ${want}`;
}

/** Polls (up to 3 minutes by default) until every target shows the tag's version. */
export async function verifyRelease(
  o: Deps & {
    tag: string;
    demoUrl?: string;
    timeoutMs?: number;
    intervalMs?: number;
  },
): Promise<{ ok: boolean; problems: string[] }> {
  if (!/^v\d+\.\d+\.\d+$/.test(o.tag))
    throw new Error(`tag must look like vX.Y.Z, got ${JSON.stringify(o.tag)}`);
  const want = o.tag.slice(1);
  const checks: [string, () => Promise<string | undefined>][] = [
    ["prod", () => healthVersion(o, PROD, "prod", want)],
    ["landing", () => landingVersion(o, want)],
    ...(o.demoUrl
      ? ([
          ["demo", () => healthVersion(o, o.demoUrl as string, "demo", want)],
        ] as [string, () => Promise<string | undefined>][])
      : []),
  ];
  const start = o.now();
  const deadline = start + (o.timeoutMs ?? TIMEOUT_MS);
  const interval = o.intervalMs ?? INTERVAL_MS;
  const last = new Map<string, string>();
  let pending = checks;
  for (;;) {
    const next: typeof checks = [];
    for (const c of pending) {
      const problem = await c[1]();
      if (problem) {
        last.set(c[0], problem);
        next.push(c);
      } else last.delete(c[0]);
    }
    pending = next;
    if (!pending.length) return { ok: true, problems: [] };
    if (o.now() + interval > deadline)
      return {
        ok: false,
        problems: pending.map((c) => last.get(c[0]) as string),
      };
    await o.sleep(interval);
  }
}

async function gh(exec: Exec, args: string[]): Promise<string> {
  const r = await exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

/** Opens (or comments on) the `blocker` issue "Release vX.Y.Z not live: <what>". */
export async function reportNotLive(o: {
  exec: Exec;
  repo: string;
  tag: string;
  problems: string[];
}): Promise<void> {
  const prefix = `Release ${o.tag} not live:`;
  const title = `${prefix} ${o.problems.join("; ")}`;
  const body = [
    `${o.tag} was released and deployed, but the live checks do not show it:`,
    "",
    ...o.problems.map((p) => `- ${p}`),
  ].join("\n");
  const existing: { number: number; title: string }[] = JSON.parse(
    await gh(o.exec, [
      "issue",
      "list",
      "--repo",
      o.repo,
      "--label",
      "blocker",
      "--state",
      "open",
      "--json",
      "number,title",
      "--limit",
      "50",
    ]),
  );
  const same = existing.find((i) => i.title.startsWith(prefix));
  if (same) {
    await gh(o.exec, [
      "issue",
      "comment",
      String(same.number),
      "--repo",
      o.repo,
      "--body",
      `Still not live:\n\n${body}`,
    ]);
    return;
  }
  await gh(o.exec, [
    "label",
    "create",
    "blocker",
    "--repo",
    o.repo,
    "--force",
    "--color",
    "B60205",
    "--description",
    "A release or deploy is stuck",
  ]);
  await gh(o.exec, [
    "issue",
    "create",
    "--repo",
    o.repo,
    "--title",
    title,
    "--body",
    body,
    "--label",
    "blocker",
  ]);
}

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

async function main(argv: string[]) {
  const arg = (f: string) => {
    const i = argv.indexOf(f);
    return i > -1 ? argv[i + 1] : undefined;
  };
  const tag = arg("--tag");
  const repo = arg("--repo");
  if (!tag || !repo) {
    console.error(
      "usage: verify-release.ts --tag vX.Y.Z --repo owner/name [--demo-url URL]",
    );
    return 2;
  }
  const r = await verifyRelease({
    tag,
    demoUrl: arg("--demo-url"),
    fetch,
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: Date.now,
  });
  if (r.ok) {
    console.log(`${tag} is live`);
    return 0;
  }
  for (const p of r.problems) console.error(`not live: ${p}`);
  await reportNotLive({ exec: realExec, repo, tag, problems: r.problems });
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    },
  );
