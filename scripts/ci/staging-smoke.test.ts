import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script, write } from "./stubs.ts";

const team = /"ACCESS_TEAM_DOMAIN": *"([^"]*)"/.exec(
  readFileSync(join(root, "apps/server/wrangler.staging.jsonc"), "utf8"),
)?.[1] as string;
const BASE = "https://staging.open-artifacts.com";
// curl stub: prints $CURL_HEADERS when -D - is given, body to -o file or stdout.
const curl = `
out=""; dump=0; args=("$@")
for ((i=0;i<$#;i++)); do case "\${args[i]}" in -o) out="\${args[i+1]}";; -D) dump=1;; esac; done
[ $dump = 1 ] && cat "$CURL_HEADERS"
if [ -n "$out" ] && [ "$out" != /dev/null ]; then cat "$CURL_BODY" > "$out"
elif [ $dump = 0 ]; then cat "$CURL_BODY"; fi
true`;

function smoke(check: string, headers: string, body: string) {
  const sb = sandbox({ curl });
  write(join(sb.dir, "h"), headers);
  write(join(sb.dir, "b"), body);
  const r = sb.run(["bash", script("staging-smoke.sh"), check, BASE], {
    env: { CURL_HEADERS: join(sb.dir, "h"), CURL_BODY: join(sb.dir, "b") },
  });
  return { ...r, sb };
}
const redirect = (loc: string) =>
  `HTTP/2 302\r\nlocation: ${loc}\r\ncontent-length: 0\r\n\r\n`;

describe("staging-smoke.sh", () => {
  it("healthz passes on ok:true", () => {
    const r = smoke("healthz", "", '{"ok":true}');
    expect(r.code).toBe(0);
    expect(r.sb.log()[0]).toContain(`${BASE}/healthz`);
  });
  it("healthz fails on ok:false", () => {
    expect(smoke("healthz", "", '{"ok":false}').code).not.toBe(0);
  });
  it("robots passes with noindex header and Disallow", () => {
    const r = smoke(
      "robots",
      "HTTP/2 200\r\nx-robots-tag: noindex, nofollow\r\n\r\n",
      "User-agent: *\nDisallow: /\n",
    );
    expect(r.code).toBe(0);
  });
  it("robots fails without the noindex header", () => {
    const r = smoke("robots", "HTTP/2 200\r\n\r\n", "Disallow: /\n");
    expect(r.code).not.toBe(0);
  });
  it("login passes on a 302 to the Access OIDC URL", () => {
    const r = smoke(
      "login",
      redirect(`https://${team}/cdn-cgi/access/sso/oidc/abc/authorization?x=1`),
      "",
    );
    expect(r.code).toBe(0);
  });
  it("login keeps only the last response of a retried request", () => {
    const r = smoke(
      "login",
      `HTTP/2 502\r\n\r\n${redirect(`https://${team}/cdn-cgi/access/sso/oidc/a`)}`,
      "",
    );
    expect(r.code).toBe(0);
  });
  it("login fails on a 302 to somewhere else", () => {
    const r = smoke("login", redirect("https://evil.example/"), "");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Location does not start with");
  });
  it("login fails on a non-302", () => {
    expect(smoke("login", "HTTP/2 200\r\n\r\n", "").code).toBe(1);
  });
});
