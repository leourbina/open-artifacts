import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox } from "../ci/stubs.ts";

// curl stub: CODE overrides the verify status, BODY the response; stdin (the -K config) goes to $STUB_LOG.cfg.
const curl = `
out=""; args=("$@")
for ((i=0;i<$#;i++)); do [ "\${args[i]}" = -o ] && out="\${args[i+1]}"; done
cat > "$STUB_LOG.cfg"
code="\${CODE:-200}"
body="\${BODY:-}"; [ -n "$body" ] || body='{"result":{"id":"tok456","status":"active"}}'
printf '%s' "$body" > "$out"; printf '%s' "$code"
[ "$code" = 200 ] || exit 22`;

const run = (env: Record<string, string> = {}) => {
  const sb = sandbox({ curl });
  const r = sb.run(["bash", join(root, "scripts/ops/staging-token-id.sh")], {
    env: { CLOUDFLARE_API_TOKEN: "s3cret-token", ...env },
  });
  return { ...r, sb };
};

describe("staging-token-id.sh", () => {
  it("prints only the token id and status, never the token", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("id=tok456 status=active");
    expect(r.out + r.err + r.sb.log().join("\n")).not.toContain("s3cret-token");
  });
  it("sends the token only as a curl -K stdin header", () => {
    const r = run();
    expect(r.sb.log().join("\n")).toContain("-K -");
    expect(readFileSync(join(r.sb.dir, "calls.log.cfg"), "utf8")).toContain(
      "Authorization: Bearer s3cret-token",
    );
  });
  it("fails on an inactive token or a body without an id", () => {
    expect(
      run({ BODY: '{"result":{"id":"tok456","status":"disabled"}}' }).code,
    ).not.toBe(0);
    expect(run({ BODY: '{"result":{"status":"active"}}' }).code).not.toBe(0);
  });
  it("fails when verify is not 200", () => {
    expect(run({ CODE: "401" }).code).not.toBe(0);
  });
  it("fails without a token", () => {
    expect(run({ CLOUDFLARE_API_TOKEN: "" }).code).not.toBe(0);
  });
});
