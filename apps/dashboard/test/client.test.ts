import {
  ApiErrorSchema,
  type ErrorCode,
  MeSchema,
  QUOTA_MESSAGE,
  R,
  STATUS_FOR,
} from "@oa/shared";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ApiClientError, api } from "../src/api/client";

const errorBody = (code: ErrorCode, message: string) =>
  HttpResponse.json(ApiErrorSchema.parse({ error: { code, message } }), {
    status: STATUS_FOR[code],
  });

const ORIGIN = "http://localhost";
const at = (p: string) => ORIGIN + p;
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  // Node's fetch needs absolute URLs; the client uses same-origin paths.
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (u: RequestInfo | URL, init?: RequestInit) =>
    realFetch(new URL(u as string, ORIGIN).href, init),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

const caught = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection");
};

describe("api client", () => {
  it("send sets X-OA-Request: 1 and same-origin JSON", async () => {
    let seen: Headers | undefined;
    server.use(
      http.post(at(R.tokens), ({ request }) => {
        seen = request.headers;
        return HttpResponse.json({ ok: true });
      }),
    );
    await api.send("POST", R.tokens, { label: "x" });
    expect(seen?.get("x-oa-request")).toBe("1");
    expect(seen?.get("content-type")).toBe("application/json");
  });

  it("send resolves undefined on 204", async () => {
    server.use(
      http.delete(
        at(R.token("t1")),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    await expect(
      api.send("DELETE", R.token("t1"), undefined),
    ).resolves.toBeUndefined();
  });

  it("maps a 404 ApiError to ApiClientError not_found", async () => {
    server.use(http.get(at(R.me), () => errorBody("not_found", "nope")));
    const e = await caught(api.get(R.me, MeSchema));
    expect(e).toBeInstanceOf(ApiClientError);
    expect(e).toMatchObject({
      code: "not_found",
      status: 404,
      message: "nope",
    });
  });

  it("throws internal naming the field when the response fails its schema", async () => {
    server.use(
      http.get(at(R.me), () => HttpResponse.json({ user: {}, instance: {} })),
    );
    const e = (await caught(api.get(R.me, MeSchema))) as ApiClientError;
    expect(e).toBeInstanceOf(ApiClientError);
    expect(e.code).toBe("internal");
    expect(e.message).toMatch(/user\.|instance\./);
  });

  it("surfaces 503 quota_exceeded with QUOTA_MESSAGE", async () => {
    server.use(
      http.get(at(R.me), () => errorBody("quota_exceeded", QUOTA_MESSAGE)),
    );
    const e = await caught(api.get(R.me, MeSchema));
    expect(e).toMatchObject({
      code: "quota_exceeded",
      status: 503,
      message: QUOTA_MESSAGE,
    });
  });

  it("maps non-JSON and unknown-shaped error bodies to internal with HTTP status", async () => {
    server.use(
      http.get(
        at(R.me),
        () => new HttpResponse("<html>bad gateway</html>", { status: 502 }),
      ),
    );
    expect(await caught(api.get(R.me, MeSchema))).toMatchObject({
      code: "internal",
      status: 502,
    });
    server.use(
      http.get(at(R.me), () => HttpResponse.json({ foo: 1 }, { status: 418 })),
    );
    expect(await caught(api.get(R.me, MeSchema))).toMatchObject({
      code: "internal",
      status: 418,
    });
  });

  it("maps a network failure to internal", async () => {
    server.use(http.get(at(R.me), () => HttpResponse.error()));
    const e = await caught(api.get(R.me, MeSchema));
    expect(e).toBeInstanceOf(ApiClientError);
    expect(e).toMatchObject({ code: "internal" });
  });
});
