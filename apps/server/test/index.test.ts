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
  it("HEAD works on known paths", async () => {
    for (const path of ["/healthz", "/robots.txt"]) {
      const r = await worker.fetch(
        new Request(`https://x.test${path}`, { method: "HEAD" }),
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });
  it("405 with Allow on other methods", async () => {
    for (const path of ["/healthz", "/robots.txt"]) {
      const r = await worker.fetch(
        new Request(`https://x.test${path}`, { method: "POST" }),
      );
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("GET, HEAD");
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });
  it("trailing slash stays 404", async () => {
    expect((await get("/healthz/")).status).toBe(404);
  });
});
