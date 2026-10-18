// Inline text is sized without encoding it and stored by R2 from the string:
// stored bytes and manifest sizes must equal TextEncoder's encoding.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { publish } from "../src/services/artifacts.js";
import { planFiles } from "../src/services/manifest.js";
import { getUser } from "../src/services/users.js";
import { utf8Length } from "../src/util/text.js";
import { login } from "./helpers.js";

const enc = new TextEncoder();

describe("utf8Length", () => {
  for (const s of [
    "",
    "plain ascii",
    "é€😀".repeat(9000),
    `${"a".repeat(16 * 1024 - 1)}😀tail`,
  ])
    it(`equals TextEncoder for ${s.length} units`, () => {
      expect(utf8Length(s)).toBe(enc.encode(s).length);
    });
});

describe("inline text sources", () => {
  it("well-formed text stays a string with its UTF-8 size; lone surrogates are encoded", () => {
    const ok = planFiles({ title: "t", format: "markdown", content: "é😀" });
    expect(ok.files[0]?.source).toEqual({ text: "é😀", size: 6 });
    const lone = planFiles({ title: "t", files: { "a.txt": "a\ud800b" } });
    expect(lone.files[0]?.source).toEqual({ bytes: enc.encode("a\ud800b") });
  });

  it("R2 stores exactly TextEncoder's bytes; manifest sizes match", async () => {
    const u = await login("inline-text@x.com", "member");
    const user = await getUser(env, u.userId);
    if (!user) throw new Error("no user");
    const files = {
      "index.html": `<p>héllo ${"😀".repeat(3000)}</p>`,
      "lone.txt": "x\udc00y",
    };
    const r = await publish(env, user, { title: "t", files } as never, null);
    const row = await env.DB.prepare(
      "select manifest from versions where artifact_id = ? and version = ?",
    )
      .bind(r.id, r.version)
      .first<{ manifest: string }>();
    const manifest = JSON.parse(row?.manifest ?? "[]") as {
      path: string;
      key: string;
      size: number;
    }[];
    expect(manifest).toHaveLength(2);
    for (const m of manifest) {
      const want = enc.encode(files[m.path as keyof typeof files]);
      const obj = await env.FILES.get(m.key);
      const got = new Uint8Array(await (obj as R2ObjectBody).arrayBuffer());
      expect(m.size).toBe(want.length);
      expect(obj?.size).toBe(want.length);
      expect(got).toEqual(want);
    }
  });
});
