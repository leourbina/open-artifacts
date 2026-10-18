import { ApiErrorSchema, type ErrorCode } from "@oa/shared";
import type { z } from "zod";

export class ApiClientError extends Error {
  code: ErrorCode;
  status: number;
  details?: unknown;
  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const internal = (message: string, status: number) =>
  new ApiClientError("internal", message, status);

function toError(text: string, status: number): ApiClientError {
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const parsed = ApiErrorSchema.safeParse(json);
  if (!parsed.success)
    return internal(`Unexpected response (HTTP ${status})`, status);
  const { code, message, details } = parsed.data.error;
  return new ApiClientError(code, message, status, details);
}

async function request(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw internal(e instanceof Error ? e.message : "Network error", 0);
  }
  if (res.ok) return res;
  throw toError(await res.text().catch(() => ""), res.status);
}

async function parse<T>(
  res: Response,
  schema: z.ZodType<T> | undefined,
): Promise<T> {
  if (!schema || res.status === 204) return undefined as T;
  const out = schema.safeParse(await res.json().catch(() => null));
  if (out.success) return out.data;
  const fields = [
    ...new Set(out.error.issues.map((i) => i.path.join(".") || "(root)")),
  ];
  throw internal(`Invalid response: ${fields.join(", ")}`, res.status);
}

export const api = {
  async get<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return parse(await request(path, { method: "GET", signal }), schema);
  },
  /** Raw body as text (for file contents), with its content type. */
  async getText(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; contentType: string }> {
    const res = await request(path, { method: "GET", signal });
    return {
      text: await res.text(),
      contentType: res.headers.get("content-type") ?? "",
    };
  },
  async send<T = void>(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    schema?: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = { "X-OA-Request": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    return parse(res, schema);
  },
  /** XHR (not fetch) so upload progress is observable. */
  putRaw(
    url: string,
    body: Blob,
    contentType: string,
    onProgress?: (p: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => new DOMException("Aborted", "AbortError");
      if (signal?.aborted) return reject(abort());
      const xhr = new XMLHttpRequest();
      signal?.addEventListener("abort", () => {
        xhr.abort();
        reject(abort());
      });
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(toError(xhr.responseText, xhr.status));
      xhr.onerror = () => reject(internal("Upload failed", 0));
      xhr.send(body);
    });
  },
};
