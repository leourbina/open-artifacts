import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// P2 T14 release guard: the setup template (every release install) defines
// the hooks flag as the boolean expression `false` (wrangler define values
// are JS source strings), so test-hooks/ is folded out of the bundle.
const server = join(import.meta.dirname, "../..");

describe("wrangler.template.jsonc", () => {
  it("defines __OA_TEST_HOOKS_ALLOWED__ as the boolean false", () => {
    const cfg = JSON.parse(
      readFileSync(join(server, "wrangler.template.jsonc"), "utf8"),
    );
    const v = cfg.define?.__OA_TEST_HOOKS_ALLOWED__;
    expect(v).toBe("false");
    expect(JSON.parse(v)).toBe(false);
  });

  it("never sets the hooks' runtime vars", () => {
    const cfg = JSON.parse(
      readFileSync(join(server, "wrangler.template.jsonc"), "utf8"),
    );
    for (const k of ["TEST_HOOKS", "TEST_HOOK_KEY", "TEST_DOMAIN"])
      expect(cfg.vars).not.toHaveProperty(k);
  });
});
