import { join } from "node:path";
import type { Deps, Exec } from "../src/cf.ts";

export const ROOT = "/repo";
export const STATE = join(ROOT, ".openartifacts/state.json");
export const FLAGS = [
  ...["--app-host", "app.example.com", "--content-host", "c.example.com"],
  ...["--owner-email", "o@example.com", "--yes", "--json"],
];

/** Cloudflare v4 envelope, as recorded from api.cloudflare.com. */
export const envelope = (
  result: unknown,
  status = 200,
  errors: unknown[] = [],
) =>
  new Response(JSON.stringify({ success: status < 400, errors, result }), {
    status,
  });

type Core = {
  answers?: string[];
  env?: Record<string, string>;
  files?: Record<string, string>;
  exec?: Exec;
  stdout?: string;
  fetch?: typeof fetch;
};

/** In-memory fs, captured output, scripted prompts; no network, no processes. */
export function core(o: Core = {}) {
  const files = new Map(Object.entries(o.files ?? {}));
  const lines: string[] = [];
  const prompts: string[] = [];
  const answers = [...(o.answers ?? [])];
  const deps: Deps = {
    env: o.env ?? {},
    fs: {
      read: (p) => files.get(p) ?? null,
      write: (p, d) => void files.set(p, d),
    },
    out: (l) => void lines.push(l),
    prompt: async (q) => {
      prompts.push(q);
      return answers.shift() ?? "";
    },
    exec:
      o.exec ?? (async () => ({ code: 0, stdout: o.stdout ?? "", stderr: "" })),
    fetch: o.fetch ?? (async () => envelope(null, 500)),
  };
  const state = () => JSON.parse(files.get(STATE) ?? "{}");
  return { deps, files, lines, prompts, state };
}
