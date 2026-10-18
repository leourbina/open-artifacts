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

async function request(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch (e) {
    throw internal(e instanceof Error ? e.message : "Network error", 0);
  }
  if (res.ok) return res;
  const parsed = ApiErrorSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success)
    throw internal(`Unexpected response (HTTP ${res.status})`, res.status);
  const { code, message, details } = parsed.data.error;
  throw new ApiClientError(code, message, res.status, details);
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
  async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return parse(await request(path, { method: "GET" }), schema);
  },
  async send<T = void>(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const headers: Record<string, string> = { "X-OA-Request": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return parse(res, schema);
  },
  /** XHR (not fetch) so upload progress is observable. */
  putRaw(
    url: string,
    body: Blob,
    contentType: string,
    onProgress?: (p: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(internal(`Upload failed (HTTP ${xhr.status})`, xhr.status));
      xhr.onerror = () => reject(internal("Upload failed", 0));
      xhr.send(body);
    });
  },
};
