import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP, run } from "../src/index.ts";
import { renderConfig } from "../src/steps/resources.ts";
import { ROOT, STATE } from "./fakes.ts";
import { BASE, world } from "./world.ts";

const CONFIG = join(ROOT, "apps/server/wrangler.jsonc");
const TEMPLATE = readFileSync(
  join(import.meta.dirname, "../../../apps/server/wrangler.template.jsonc"),
  "utf8",
);
const PAID = [{ rate_plan: { id: "WORKERS_PAID" }, state: "Paid" }];
const FREE = [{ rate_plan: { id: "free" } }];
const CI = [...BASE.filter((a) => a !== "--yes"), "--ci", "--solo"];
type W = ReturnType<typeof world>;
const parse = (w: W) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, step: string) => parse(w).find((j) => j.step === step);
const planOf = (w: W) => JSON.parse(w.files.get(CONFIG) ?? "").vars.PLAN;
const vars = {
  WORKER_NAME: "w",
  APP_HOST: "a.example.com",
  CONTENT_HOST: "c.example.com",
  OWNER_EMAIL: "o@example.com",
  D1_NAME: "d",
  D1_ID: "d1",
  R2_BUCKET: "r",
  KV_ID: "k",
  CF_ACCOUNT_ID: "acc",
  ACCESS_TEAM_DOMAIN: "t",
  ACCESS_CLIENT_ID: "c",
};

describe("renderConfig PLAN", () => {
  it("renders free by default and paid when asked, as strict JSON", () => {
    expect(JSON.parse(renderConfig(TEMPLATE, vars)).vars.PLAN).toBe("free");
    const paid = renderConfig(TEMPLATE, vars, true, false, "paid");
    expect(JSON.parse(paid).vars.PLAN).toBe("paid");
  });
});

describe("--plan and the rendered PLAN var", () => {
  it("--help documents --plan", () => {
    expect(HELP).toContain("--plan");
  });

  it("rejects a bad --plan value", async () => {
    const w = world();
    expect(await run([...BASE, "--plan", "gold"], w.deps, ROOT)).not.toBe(0);
    expect(w.lines.join("\n")).toContain("--plan");
  });

  it("detected paid renders paid; free renders free; reported next to plan", async () => {
    const p = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo"], p.deps, ROOT)).toBe(0);
    expect(planOf(p)).toBe("paid");
    expect(line(p, "prereqs").data).toMatchObject({
      plan: "paid",
      planVar: "paid",
    });
    expect(p.state()).toMatchObject({ planVar: "paid" });
    const f = world({ subscriptions: FREE });
    expect(await run([...BASE, "--solo"], f.deps, ROOT)).toBe(0);
    expect(planOf(f)).toBe("free");
    expect(line(f, "prereqs").data).toMatchObject({
      plan: "free",
      planVar: "free",
    });
  });

  it("unknown plan renders free; --yes-paid and --plan paid render paid", async () => {
    const u = world();
    expect(await run([...BASE, "--solo"], u.deps, ROOT)).toBe(0);
    expect(planOf(u)).toBe("free");
    const y = world();
    expect(await run([...BASE, "--solo", "--yes-paid"], y.deps, ROOT)).toBe(0);
    expect(planOf(y)).toBe("paid");
    const p = world();
    expect(await run([...BASE, "--solo", "--plan", "paid"], p.deps, ROOT)).toBe(
      0,
    );
    expect(planOf(p)).toBe("paid");
  });

  it("--plan overrides detection both ways", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo", "--plan", "free"], w.deps, ROOT)).toBe(
      0,
    );
    expect(planOf(w)).toBe("free");
    const f = world({ subscriptions: FREE });
    expect(await run([...BASE, "--solo", "--plan", "paid"], f.deps, ROOT)).toBe(
      0,
    );
    expect(planOf(f)).toBe("paid");
  });

  it("--upgrade with an unknown plan keeps the saved value", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    w.setSubscriptions(undefined);
    expect(
      await run([...BASE, "--solo", "--upgrade", "--browser"], w.deps, ROOT),
    ).toBe(0);
    expect(planOf(w)).toBe("paid");
  });
});

describe("downgrade guard", () => {
  it("refuses a free render over a live paid PLAN without --plan free", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    w.files.delete(STATE); // stateless: only the live Worker knows
    w.setSubscriptions(undefined);
    w.lines.length = 0;
    const up = [...CI, "--upgrade", "--no-browser"];
    expect(await run(up, w.deps, ROOT)).toBe(2);
    const l = line(w, "deploy");
    expect(l.status).toBe("action_required");
    expect(l.message).toContain("--plan free");
    expect(w.ops.filter((o) => o === "deploy")).toHaveLength(1);
    expect(await run([...up, "--plan", "free"], w.deps, ROOT)).toBe(0);
    expect(planOf(w)).toBe("free");
  });

  it("also guards from saved state when the live read is unavailable", async () => {
    const w = world({ subscriptions: PAID, settingsFail: true });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    w.setSubscriptions(FREE);
    w.lines.length = 0;
    const up = [...BASE, "--solo", "--upgrade", "--no-browser"];
    expect(await run(up, w.deps, ROOT)).toBe(2);
    expect(line(w, "deploy").message).toContain("--plan free");
  });
});

describe("selftest checks /healthz plan", () => {
  it("passes when healthz plan equals the rendered PLAN", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    expect(line(w, "selftest").status).toBe("ok");
  });

  it("fails with a clear message on a mismatch", async () => {
    const w = world({ subscriptions: PAID, healthPlan: "free" });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(1);
    const l = line(w, "selftest");
    expect(l.status).toBe("error");
    expect(l.message).toContain("PLAN");
    expect(l.message).toContain("paid");
  });
});
