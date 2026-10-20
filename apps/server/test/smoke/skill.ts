import { describe, expect, it } from "vitest";

const base = process.env.STAGING_URL;

describe.skipIf(!base)("staging smoke: skill.md", () => {
  it("GET /skill.md is this instance's skill, at /healthz's version", async () => {
    const r = await fetch(`${base}/skill.md`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const md = await r.text();
    const host = new URL(base ?? "").host;
    expect(md).toMatch(/^---\nname: open-artifacts-[a-z0-9]+(-[a-z0-9]+)*\n/);
    expect(md).toContain(`\n# Open Artifacts (${host})\n`);
    expect(md).toContain(`\`${base}/mcp\``);
    expect(md).not.toContain("{{");
    const { version } = (await (await fetch(`${base}/healthz`)).json()) as {
      version: string;
    };
    expect(md).toContain(`  version: "${version}"\n`);
    expect(r.headers.get("etag")).toMatch(
      new RegExp(
        `^"${version.replace(/[.+]/g, "\\$&")}-(free|paid)-[0-9a-f]{8}"$`,
      ),
    );
  });
});
