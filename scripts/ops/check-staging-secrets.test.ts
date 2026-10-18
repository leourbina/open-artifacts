import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { missingSecrets, requiredSecrets } from "./check-staging-secrets";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const envTs = readFileSync(join(root, "apps/server/src/env.ts"), "utf8");
const wrangler = readFileSync(
  join(root, "apps/server/wrangler.staging.jsonc"),
  "utf8",
);
const list = (...names: string[]) =>
  names.map((name) => ({ name, type: "secret_text" }));
const ALL = [
  "ACCESS_CLIENT_SECRET",
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
  "CF_ACCOUNT_ID",
];

describe("requiredSecrets", () => {
  it("derives non-optional, non-var string fields of Env", () => {
    expect(requiredSecrets(envTs, wrangler).sort()).toEqual([...ALL].sort());
  });
});

describe("missingSecrets", () => {
  it("names every missing required secret", () => {
    expect(
      missingSecrets(
        envTs,
        wrangler,
        list("ACCESS_CLIENT_SECRET", "CF_ACCOUNT_ID"),
      ),
    ).toEqual(["SESSION_SECRET", "CONTENT_SIGNING_KEY"]);
  });
  it("is ok when all are present", () => {
    expect(missingSecrets(envTs, wrangler, list(...ALL))).toEqual([]);
  });
  it("ignores a missing optional field and extra secrets", () => {
    expect(
      missingSecrets(envTs, wrangler, list(...ALL, "ANALYTICS_TOKEN")),
    ).toEqual([]);
    expect(missingSecrets(envTs, wrangler, list(...ALL, "OTHER"))).toEqual([]);
  });
});

describe("cli", () => {
  const run = (stdin: string) =>
    spawnSync("node", [join(root, "scripts/ops/check-staging-secrets.ts")], {
      input: stdin,
      encoding: "utf8",
      cwd: root,
    });
  it("exits non-zero naming missing secrets (names only)", () => {
    const r = run(JSON.stringify(list("CF_ACCOUNT_ID")));
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain(
      "::error::missing Worker secrets: ACCESS_CLIENT_SECRET, SESSION_SECRET, CONTENT_SIGNING_KEY",
    );
  });
  it("exits zero when complete", () => {
    expect(run(JSON.stringify(list(...ALL))).status).toBe(0);
  });
  it("fails on unparseable input", () => {
    expect(run("not json").status).not.toBe(0);
  });
});
