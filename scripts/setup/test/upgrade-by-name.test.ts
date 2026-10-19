import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT, STATE } from "./fakes.ts";
import { app, onboarded, POLICY, world } from "./world.ts";

type Opts = NonNullable<Parameters<typeof world>[0]>;
type W = ReturnType<typeof world>;
const parse = (w: W) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, step: string) => parse(w).find((j) => j.step === step);
const SECRETS = [
  "ACCESS_CLIENT_SECRET",
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
];
const VARS = {
  ENVIRONMENT: "production",
  APP_HOST: "app.example.com",
  CONTENT_HOST: "a.b.usercontent.example.com",
  OWNER_EMAIL: "owner@example.com",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_CLIENT_ID: "cid-open-artifacts",
};
const ONLY = ["--name", "open-artifacts", "--yes", "--json", "--upgrade"];
const cloud = (o: Opts = {}) =>
  world({
    d1: [{ uuid: "d1-live", name: "open-artifacts" }],
    r2: [{ name: "open-artifacts" }],
    kv: [{ id: "kv-live", title: "open-artifacts-oauth" }],
    policies: [POLICY],
    apps: [app("open-artifacts")],
    secrets: SECRETS,
    worker: VARS,
    ...o,
  });
const ok = (w: W) => {
  w.deps.env.OA_ACCESS_TOKEN = "oa-ci";
  return w;
};

describe("--upgrade --name without saved state", () => {
  it("needs only --name: hosts and owner come from the Worker's vars", async () => {
    const w = ok(cloud());
    expect(await run(ONLY, w.deps, ROOT)).toBe(0);
    expect(w.state()).toMatchObject({
      name: "open-artifacts",
      appHost: "app.example.com",
      contentHost: "a.b.usercontent.example.com",
      ownerEmail: "owner@example.com",
    });
    expect(w.ops).toEqual(["build", "migrate open-artifacts", "deploy"]);
  });

  it("reads PLAN, EMAIL_FROM, send_email and browser into the choices", async () => {
    const w = ok(
      cloud({
        subscriptions: [{ rate_plan: { id: "WORKERS_PAID" }, state: "Paid" }],
        dns: onboarded("mail.example.com"),
        worker: {
          ...VARS,
          PLAN: "paid",
          EMAIL_FROM: "noreply@mail.example.com",
        },
        workerBindings: [
          { type: "send_email", name: "EMAIL" },
          { type: "browser", name: "BROWSER" },
        ],
      }),
    );
    expect(await run(ONLY, w.deps, ROOT)).toBe(0);
    expect(w.state()).toMatchObject({
      planVar: "paid",
      team: true,
      email: true,
      emailDomain: "mail.example.com",
      browser: true,
    });
  });

  it("no send_email binding reads as solo", async () => {
    const w = ok(cloud());
    expect(await run(ONLY, w.deps, ROOT)).toBe(0);
    expect(w.state().team).toBe(false);
  });

  it("a flag wins over the Worker's value, with a note", async () => {
    const w = ok(cloud());
    const argv = [...ONLY, "--owner-email", "other@example.com"];
    // Access still refuses a host or owner that differs from the deployed one.
    expect(await run(argv, w.deps, ROOT)).toBe(2);
    expect(line(w, "access").message).toContain("differs in OWNER_EMAIL");
    expect(w.state().ownerEmail).toBe("other@example.com");
    const all = w.lines.join("\n");
    expect(all).toContain("--owner-email other@example.com differs");
    expect(all).toContain("owner@example.com");
  });

  it("an unknown Worker is action_required", async () => {
    const w = world({});
    expect(await run(ONLY, w.deps, ROOT)).toBe(2);
    expect(line(w, "args")).toMatchObject({
      status: "action_required",
      message:
        "no Worker named open-artifacts on account acc1; check --name (the Worker name from setup) or --account-id",
    });
    expect(w.ops).toEqual([]);
  });

  it("a missing var names the flag to pass", async () => {
    const { APP_HOST: _, ...rest } = VARS;
    const w = ok(cloud({ worker: rest }));
    expect(await run(ONLY, w.deps, ROOT)).toBe(2);
    expect(line(w, "args")).toMatchObject({
      status: "action_required",
      message: "pass --app-host (the deployed Worker has no APP_HOST)",
    });
  });

  it("passing the flag covers a missing var", async () => {
    const { APP_HOST: _, ...rest } = VARS;
    const w = ok(cloud({ worker: rest }));
    await run([...ONLY, "--app-host", "app.example.com"], w.deps, ROOT);
    // Past argument resolution: only a later step (access) objects.
    expect(line(w, "args")).toBeUndefined();
    expect(line(w, "prereqs")).toBeDefined();
  });

  it("never reads or prints secret_text values", async () => {
    const w = ok(
      cloud({
        workerBindings: [
          { type: "secret_text", name: "OWNER_EMAIL", text: "CANARY-1" },
          { type: "secret_text", name: "APP_HOST", text: "CANARY-2" },
        ],
      }),
    );
    expect(await run(ONLY, w.deps, ROOT)).toBe(0);
    const hay = [...w.lines, ...w.files.values()].join("\n");
    expect(hay).not.toContain("CANARY");
    expect(w.state().ownerEmail).toBe("owner@example.com");
  });

  it("reports where each value came from", async () => {
    const w = ok(cloud());
    const argv = [...ONLY, "--owner-email", "OWNER@example.com"];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(parse(w).at(-1).data.sources).toEqual({
      appHost: "worker",
      contentHost: "worker",
      ownerEmail: "flag",
    });
  });

  it("--check reports the sources and writes nothing", async () => {
    const w = cloud();
    const argv = ["--name", "open-artifacts", "--json", "--upgrade", "--check"];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(parse(w).at(-1).data.sources.appHost).toBe("worker");
    expect(w.files.has(STATE)).toBe(false);
  });

  it("the downgrade guard still blocks on this path", async () => {
    const w = ok(cloud({ healthVersion: "9.0.0" }));
    expect(await run(ONLY, w.deps, ROOT)).toBe(2);
    expect(line(w, "prereqs")).toMatchObject({ status: "action_required" });
    expect(line(w, "prereqs").message).toContain(
      "older than the deployed 9.0.0",
    );
    expect(w.ops).toEqual([]);
  });

  it("saved state wins over the Worker's vars and is untouched", async () => {
    const w = ok(
      cloud({
        state: {
          name: "open-artifacts",
          appHost: "saved.example.com",
          contentHost: "a.b.usercontent.example.com",
          ownerEmail: "owner@example.com",
        },
      }),
    );
    await run(ONLY, w.deps, ROOT);
    expect(w.state().appHost).toBe("saved.example.com");
    expect(parse(w).at(-1).data?.sources).toBeUndefined();
  });

  it("is not read without --upgrade", async () => {
    const w = ok(cloud());
    const argv = ONLY.filter((a) => a !== "--upgrade");
    expect(await run(argv, w.deps, ROOT)).not.toBe(0);
    expect(line(w, "args").message).toContain("--app-host");
  });
});

describe("HELP", () => {
  it("says --upgrade needs only --name without state", async () => {
    const { HELP } = await import("../src/index.ts");
    expect(HELP).toMatch(/--upgrade.*no saved state.*only --name/s);
  });
});
