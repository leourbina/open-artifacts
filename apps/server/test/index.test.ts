import { describe, expect, it } from "vitest";
import worker from "../src/index";

const get = (path: string) =>
  worker.fetch(new Request(`https://x.test${path}`));

describe("worker", () => {
  it("GET /healthz", async () => {
    const r = await get("/healthz");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(r.headers.get("set-cookie")).toBeNull();
  });
  it("GET /robots.txt", async () => {
    const r = await get("/robots.txt");
    expect(await r.text()).toBe("User-agent: *\nDisallow: /");
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
  it("404 otherwise", async () => {
    const r = await get("/nope");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
