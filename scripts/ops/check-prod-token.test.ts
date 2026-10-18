import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox } from "../ci/stubs.ts";

// curl stub: answers by URL; NO_ZONE=1 -> empty zones, ORG_CODE overrides the organizations status.
const curl = `
out=""; args=("$@"); url="\${args[$#-1]}"
for ((i=0;i<$#;i++)); do [ "\${args[i]}" = -o ] && out="\${args[i+1]}"; done
code=200; body='{"success":true,"result":[]}'
case "$url" in
  */user/tokens/verify) body='{"result":{"status":"active"}}';;
  */zones\\?name=*) [ "$NO_ZONE" = 1 ] && body='{"result":[]}' || body='{"result":[{"id":"z1","status":"active"}]}';;
  */access/organizations) code="\${ORG_CODE:-200}"; body='{"result":{"auth_domain":"leourbina.cloudflareaccess.com"}}';;
esac
printf '%s' "$body" > "$out"; printf '%s' "$code"
[ "$code" = 200 ] || exit 22`;

const run = (env: Record<string, string> = {}) => {
  const sb = sandbox({ curl });
  const r = sb.run(["bash", join(root, "scripts/ops/check-prod-token.sh")], {
    env: {
      PROD_CLOUDFLARE_API_TOKEN: "s3cret-token",
      CLOUDFLARE_ACCOUNT_ID: "acc",
      ...env,
    },
  });
  return { ...r, sb };
};

describe("check-prod-token.sh", () => {
  it("passes when every check passes, prints auth_domain, hides token", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("leourbina.cloudflareaccess.com");
    expect(r.out + r.err + r.sb.log().join("\n")).not.toContain("s3cret-token");
  });
  it("fails naming Zone: DNS when the zone is missing", () => {
    const r = run({ NO_ZONE: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Zone: DNS");
  });
  it("fails naming Access: Organizations Read on 403", () => {
    const r = run({ ORG_CODE: "403" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Access: Organizations Read");
  });
});
