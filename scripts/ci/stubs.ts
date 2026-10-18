// Test helper: tiny shell stubs on PATH that log "name argv..." to $STUB_LOG.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export interface Sandbox {
  dir: string;
  log: () => string[];
  run: (
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ) => { code: number | null; out: string; err: string };
}

/** `stubs` maps a command name to a bash body run after its argv is logged. */
export function sandbox(stubs: Record<string, string>): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "ci-stub-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  for (const [name, body] of Object.entries(stubs)) {
    const p = join(bin, name);
    writeFileSync(
      p,
      `#!/usr/bin/env bash\necho "${name} $*" >> "$STUB_LOG"\n${body}\n`,
    );
    chmodSync(p, 0o755);
  }
  return {
    dir,
    log: () => readFileSync(logFile, "utf8").split("\n").filter(Boolean),
    run(cmd, opts = {}) {
      const r = spawnSync(cmd[0] as string, cmd.slice(1), {
        encoding: "utf8",
        cwd: opts.cwd ?? dir,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          STUB_LOG: logFile,
          ...opts.env,
        },
      });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
  };
}

export const script = (n: string) => join(root, "scripts/ci", n);
export const write = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};
