// @vitest-environment jsdom
import { LIMITS } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";
import {
  defaultEntry,
  relativePaths,
  UploadValidationError,
  uploadArtifact,
} from "../src/upload/uploadPipeline";
import { installHarness, seen, server } from "./harness";

installHarness();

// msw's XHR interceptor can't build a request under jsdom; PUT via fetch so msw still sees it.
beforeEach(() => {
  vi.spyOn(api, "putRaw").mockImplementation(async (url, _body, type) => {
    await fetch(url, { method: "PUT", headers: { "Content-Type": type } });
  });
});
afterEach(() => vi.restoreAllMocks());

const file = (name: string, body = "x", rel?: string) => {
  const f = new File([body], name, { type: "text/plain" });
  if (rel) Object.defineProperty(f, "webkitRelativePath", { value: rel });
  return f;
};
const big = (name: string, size: number) => {
  const f = file(name);
  Object.defineProperty(f, "size", { value: size });
  return f;
};
const three = () => [file("index.html"), file("a.css"), file("b.js")];
const tag = (u: URL, m: string) =>
  `${m} ${u.pathname.replace(/\/uploads\/[^/]+$/, "/uploads/:id")}`;

describe("uploadArtifact", () => {
  it("creates and PUTs each file, then publishes once, in order", async () => {
    const calls: string[] = [];
    server.events.on("request:start", ({ request }) => {
      const u = new URL(request.url);
      if (u.pathname.startsWith("/api/v1/")) calls.push(tag(u, request.method));
    });
    const r = await uploadArtifact({ files: three(), title: "T" }, () => {});
    server.events.removeAllListeners();
    expect(calls).toEqual([
      "POST /api/v1/uploads",
      "PUT /api/v1/uploads/:id",
      "POST /api/v1/uploads",
      "PUT /api/v1/uploads/:id",
      "POST /api/v1/uploads",
      "PUT /api/v1/uploads/:id",
      "POST /api/v1/artifacts",
    ]);
    expect(r.version).toBe(1);
  });

  it("rejects a 26 MB file before any request", async () => {
    await expect(
      uploadArtifact(
        { files: [big("big.bin", 26 * 1024 * 1024)], title: "T" },
        () => {},
      ),
    ).rejects.toThrow(/big\.bin/);
    expect(seen).toHaveLength(0);
  });

  it("rejects a ../x path before any request", async () => {
    await expect(
      uploadArtifact({ files: [file("x", "x", "../x")], title: "T" }, () => {}),
    ).rejects.toThrow(UploadValidationError);
    expect(seen).toHaveLength(0);
  });

  it("rejects case collisions, too many bytes and too many files", async () => {
    await expect(
      uploadArtifact(
        { files: [file("A.md"), file("a.md")], title: "T" },
        () => {},
      ),
    ).rejects.toThrow(/letter case/);
    const each = LIMITS.fileBytes - 1;
    const six = Array.from({ length: 5 }, (_, i) => big(`f${i}`, each));
    await expect(
      uploadArtifact({ files: six, title: "T" }, () => {}),
    ).rejects.toThrow(/total/);
    const many = Array.from({ length: LIMITS.filesPerVersion + 1 }, (_, i) =>
      file(`f${i}`),
    );
    await expect(
      uploadArtifact({ files: many, title: "T" }, () => {}),
    ).rejects.toThrow(/Too many/);
    expect(seen).toHaveLength(0);
  });

  it("reports progress up to {done:3,total:3}", async () => {
    const onProgress = vi.fn();
    await uploadArtifact({ files: three(), title: "T" }, onProgress);
    expect(onProgress).toHaveBeenLastCalledWith({ done: 3, total: 3 });
  });

  it("stops when aborted", async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      uploadArtifact({ files: three(), title: "T" }, () => {}, c.signal),
    ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe("paths and entry", () => {
  it("strips a shared top folder only", () => {
    const f = [file("a", "x", "site/a"), file("b", "x", "site/img/b")];
    expect(relativePaths(f)).toEqual(["a", "img/b"]);
    const g = [file("a", "x", "one/a"), file("b", "x", "two/b")];
    expect(relativePaths(g)).toEqual(["one/a", "two/b"]);
    expect(relativePaths([file("a")])).toEqual(["a"]);
  });

  it("defaults to index.html, README.md, the only file, else undefined", () => {
    expect(defaultEntry(["README.md", "index.html"])).toBe("index.html");
    expect(defaultEntry(["a.js", "README.md"])).toBe("README.md");
    expect(defaultEntry(["only.txt"])).toBe("only.txt");
    expect(defaultEntry(["a.js", "b.js"])).toBeUndefined();
  });
});
