import { ApiErrorSchema, QUOTA_MESSAGE } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";

// Minimal XHR double: replies with the given status and JSON body on send().
const fakeXhr = (status: number, body: unknown) =>
  class {
    status = 0;
    responseText = "";
    response: unknown = "";
    responseType = "";
    upload: { onprogress?: unknown } = {};
    onload?: () => void;
    onerror?: () => void;
    headers: Record<string, string> = {};
    open() {}
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    getResponseHeader(k: string) {
      return k.toLowerCase() === "content-type" ? "application/json" : null;
    }
    send() {
      this.status = status;
      this.responseText = JSON.stringify(body);
      this.response = this.responseText;
      queueMicrotask(() => this.onload?.());
    }
  };

const caught = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e,
  );

afterEach(() => vi.unstubAllGlobals());

describe("putRaw", () => {
  it("surfaces a 413 too_large ApiError body instead of internal", async () => {
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr(
        413,
        ApiErrorSchema.parse({
          error: { code: "too_large", message: "file exceeds 25 MB" },
        }),
      ),
    );
    const e = await caught(
      api.putRaw(
        "/api/v1/uploads/x?sig=s&exp=1",
        new Blob(["a"]),
        "text/plain",
      ),
    );
    expect(e).toMatchObject({ code: "too_large", status: 413 });
  });
  it("surfaces 503 quota_exceeded with QUOTA_MESSAGE", async () => {
    vi.stubGlobal(
      "XMLHttpRequest",
      fakeXhr(503, {
        error: { code: "quota_exceeded", message: QUOTA_MESSAGE },
      }),
    );
    const e = await caught(
      api.putRaw(
        "/api/v1/uploads/x?sig=s&exp=1",
        new Blob(["a"]),
        "text/plain",
      ),
    );
    expect(e).toMatchObject({ code: "quota_exceeded", message: QUOTA_MESSAGE });
  });
});

describe("putRaw success", () => {
  it("resolves on 2xx and reports progress", async () => {
    class Ok {
      status = 204;
      responseText = "";
      upload: { onprogress?: (e: unknown) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      open() {}
      setRequestHeader() {}
      send() {
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 1,
          total: 4,
        });
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", Ok);
    const seen: number[] = [];
    await api.putRaw("/u", new Blob(["a"]), "text/plain", (p) => seen.push(p));
    expect(seen).toEqual([0.25]);
  });
});
