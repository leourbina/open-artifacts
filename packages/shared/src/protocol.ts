import { z } from "zod";
import { ERROR_CODES } from "./errors.js";
import { FORMATS } from "./formats.js";
import { LIMITS } from "./limits.js";
import {
  type Capabilities,
  CapabilitiesSchema,
  DataDocSchema,
  DataNameSchema,
  DataPatchBodySchema,
  DataQuerySchema,
  PageSchema,
  StorageKeyNameSchema,
  StorageKeySchema,
  ThemeSchema,
} from "./schemas.js";
import { utf8Exceeds } from "./utf8.js";

export const PROTOCOL_VERSION = 1;

export const RUNTIME_METHODS = [
  "db.get",
  "db.list",
  "db.query",
  "db.set",
  "db.update",
  "db.delete",
  "db.subscribe",
  "db.unsubscribe",
  "viewer.get",
  "storage.get",
  "storage.set",
  "storage.delete",
  "storage.list",
] as const;
export type RuntimeMethod = (typeof RUNTIME_METHODS)[number];

const THUMB_PREFIX = "data:image/webp;base64,";
const THUMB_MAX_LEN =
  THUMB_PREFIX.length + 4 * Math.ceil(LIMITS.thumbnailBytes / 3);
const THUMB_RE = /^data:image\/webp;base64,[A-Za-z0-9+/]*={0,2}$/;

const Theme = ThemeSchema;

/**
 * Anonymous id (artifacts with allowAnonymousWrites): the shell sends its
 * signed token "<id>.<sig>" in this request header on anonymous runtime calls,
 * and the server returns a new one in the same response header whenever it
 * mints one (missing, malformed or forged token). The token never enters the
 * artifact frame.
 */
export const ANON_ID_HEADER = "X-OA-Anon-Id";
/** Public part of an anonId: its first 8 chars (updatedBy "anon:<short>"). */
export const ANON_ID_SHORT_LEN = 8;
/** viewer.get() for an anonymous viewer of an artifact with allowAnonymousWrites. */
export const AnonViewerSchema = z.strictObject({
  anonId: z.string().regex(/^[A-Za-z0-9_-]{8}$/),
});
export type AnonViewer = z.infer<typeof AnonViewerSchema>;

export const ArtifactToShellSchema = z.union([
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("hello"),
    protocol: z.number().int().min(1).max(1000),
    kind: z.enum(FORMATS),
  }),
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("call"),
    id: z.string().max(200),
    method: z.enum(RUNTIME_METHODS),
    params: z.unknown(),
  }),
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("pdf.text"),
    version: z.number().int(),
    text: z
      .string()
      .max(LIMITS.extractedTextBytes)
      .refine(
        (s) => !utf8Exceeds(s, LIMITS.extractedTextBytes),
        "text too large",
      ),
  }),
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("thumb.ready"),
    dataUrl: z
      .string()
      .max(THUMB_MAX_LEN)
      .refine((s) => THUMB_RE.test(s), "must be a webp base64 data URL"),
  }),
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("resize"),
    height: z.number().finite().min(0).max(100_000),
  }),
]);
export type ArtifactToShell = z.infer<typeof ArtifactToShellSchema>;

/** `result` with `ok: true` always carries `value` (null for void methods). */
export const ShellToArtifactSchema = z.union([
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("welcome"),
    capabilities: CapabilitiesSchema,
    viewer: z
      .strictObject({ email: z.string(), name: z.string().nullable() })
      .nullable(),
    theme: Theme,
  }),
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("result"),
    id: z.string(),
    ok: z.literal(true),
    value: z.unknown(),
  }),
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("result"),
    id: z.string(),
    ok: z.literal(false),
    error: z.strictObject({ code: z.enum(ERROR_CODES), message: z.string() }),
  }),
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("event"),
    event: z.literal("db.change"),
    collection: z.string(),
    docs: z.array(DataDocSchema),
    deleted: z.array(z.string()),
  }),
  /**
   * The shell's socket for `collection` reconnected: changes may have been
   * missed, so subscribers should refetch.
   */
  z.strictObject({
    oa: z.literal(1),
    type: z.literal("event"),
    event: z.literal("db.resync"),
    collection: DataNameSchema,
  }),
  z.strictObject({ oa: z.literal(1), type: z.literal("thumb.request") }),
  z.strictObject({ oa: z.literal(1), type: z.literal("theme"), theme: Theme }),
]);
export type ShellToArtifact = z.infer<typeof ShellToArtifactSchema>;

export const METHOD_CAPABILITY: Record<RuntimeMethod, keyof Capabilities> = {
  "db.get": "db",
  "db.list": "db",
  "db.query": "db",
  "db.set": "db",
  "db.update": "db",
  "db.delete": "db",
  "db.subscribe": "db",
  "db.unsubscribe": "db",
  "viewer.get": "viewer",
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.delete": "storage",
  "storage.list": "storage",
};

export function sendToShell(msg: ArtifactToShell): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage(msg, "*");
}

export function parseArtifactMessage(data: unknown): ArtifactToShell | null {
  const r = ArtifactToShellSchema.safeParse(data);
  return r.success ? r.data : null;
}

export function parseShellMessage(data: unknown): ShellToArtifact | null {
  const r = ShellToArtifactSchema.safeParse(data);
  return r.success ? r.data : null;
}

const col = { collection: DataNameSchema };
const Doc = DataDocSchema;
const DocPage = PageSchema(Doc);

/** Strict params schema for each runtime call. */
export const RUNTIME_PARAMS = {
  "db.get": z.strictObject({ ...col, id: DataNameSchema }),
  "db.list": z.strictObject({
    ...col,
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  "db.query": z.strictObject({ ...col, query: DataQuerySchema }),
  "db.set": z.strictObject({ ...col, id: DataNameSchema, data: z.unknown() }),
  "db.update": z.strictObject({
    ...col,
    id: DataNameSchema,
    patch: DataPatchBodySchema,
  }),
  "db.delete": z.strictObject({ ...col, id: DataNameSchema }),
  "db.subscribe": z.strictObject(col),
  "db.unsubscribe": z.strictObject(col),
  "viewer.get": z.strictObject({}),
  "storage.get": z.strictObject({ key: StorageKeyNameSchema }),
  "storage.set": z.strictObject({
    key: StorageKeyNameSchema,
    value: z.unknown(),
  }),
  "storage.delete": z.strictObject({ key: StorageKeyNameSchema }),
  "storage.list": z.strictObject({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
} satisfies Record<RuntimeMethod, z.ZodType>;

export type RuntimeParams<M extends RuntimeMethod> = z.input<
  (typeof RUNTIME_PARAMS)[M]
>;

/** Result schema (the `value` of a successful `result` message) for each runtime call. */
export const RUNTIME_RESULTS = {
  "db.get": Doc.nullable(),
  "db.list": DocPage,
  "db.query": DocPage,
  "db.set": Doc,
  "db.update": Doc,
  "db.delete": z.null(),
  "db.subscribe": z.null(),
  "db.unsubscribe": z.null(),
  "viewer.get": z
    .union([
      z.object({ email: z.string(), name: z.string().nullable() }),
      AnonViewerSchema,
    ])
    .nullable(),
  "storage.get": z.unknown(),
  "storage.set": z.null(),
  "storage.delete": z.null(),
  "storage.list": PageSchema(StorageKeySchema),
} satisfies Record<RuntimeMethod, z.ZodType>;

export type RuntimeResult<M extends RuntimeMethod> = z.output<
  (typeof RUNTIME_RESULTS)[M]
>;
