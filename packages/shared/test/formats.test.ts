import { describe, expect, it } from "vitest";
import {
  contentTypeFor,
  inferFormat,
  inferLanguage,
  isTextContentType,
} from "../src/formats.js";

describe("formats", () => {
  it("inferFormat", () => {
    expect(inferFormat("index.HTML")).toBe("html");
    expect(inferFormat("a.htm")).toBe("html");
    expect(inferFormat("notes.md")).toBe("markdown");
    expect(inferFormat("a.mdx")).toBe("markdown");
    expect(inferFormat("x.pdf")).toBe("pdf");
    expect(inferFormat("main.rs")).toBe("code");
  });
  it("inferLanguage", () => {
    expect(inferLanguage("a.tsx")).toBe("tsx");
    expect(inferLanguage("src/Makefile")).toBe("makefile");
    expect(inferLanguage("x.unknown")).toBe("text");
    expect(inferLanguage("a.py")).toBe("py");
  });
  it("contentTypeFor", () => {
    expect(contentTypeFor("a/b.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("a.PNG")).toBe("image/png");
    expect(contentTypeFor("a.zzz")).toBe("application/octet-stream");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });
  it("isTextContentType", () => {
    expect(isTextContentType("text/html; charset=utf-8")).toBe(true);
    expect(isTextContentType("application/json")).toBe(true);
    expect(isTextContentType("image/svg+xml")).toBe(true);
    expect(isTextContentType("image/png")).toBe(false);
    expect(isTextContentType("application/pdf")).toBe(false);
  });
});
