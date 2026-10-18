import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { conflictingSecrets } from "./conflicting-secrets.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const list = (...names: string[]) =>
  names.map((name) => ({ name, type: "secret_text" }));
const W = (vars: string) => `{"env":{"staging":{"vars":${vars}}}}`;

describe("conflictingSecrets", () => {
  it("finds secrets that are also staging vars", () => {
    expect(
      conflictingSecrets(
        W('{"A":"1","B":"2"}'),
        list("A", "SESSION_SECRET", "B"),
      ),
    ).toEqual(["A", "B"]);
  });
  it("returns none when there is no overlap", () => {
    expect(conflictingSecrets(W('{"A":"1"}'), list("S"))).toEqual([]);
    expect(conflictingSecrets(W("{}"), list("A"))).toEqual([]);
    expect(conflictingSecrets("{}", list("A"))).toEqual([]);
  });
  it("handles comments and trailing commas in jsonc", () => {
    const src = `{
  // line comment with "vars": {"X": 1}
  "env": { "staging": {
    /* block */
    "vars": { "A": "http://x.test/a", // trailing
      "B": "2",
    },
  } }
}`;
    expect(conflictingSecrets(src, list("B", "A", "C"))).toEqual(["B", "A"]);
  });
});

describe("cli", () => {
  const run = (stdin: string) =>
    spawnSync("node", [join(root, "scripts/ops/conflicting-secrets.ts")], {
      input: stdin,
      encoding: "utf8",
      cwd: root,
    });
  it("prints one conflicting name per line (real config)", () => {
    const r = run(
      ` wrangler 4.151.1\n${JSON.stringify(list("CF_ACCOUNT_ID", "SESSION_SECRET"))}\n`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("CF_ACCOUNT_ID\n");
  });
  it("prints nothing when no conflict", () => {
    const r = run(JSON.stringify(list("SESSION_SECRET")));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
  it("exits 2 on unparseable input", () => {
    expect(run("nope").status).toBe(2);
  });
});
