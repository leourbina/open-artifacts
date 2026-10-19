type FromBase64 = (s: string) => Uint8Array;

const native = (Uint8Array as unknown as { fromBase64?: FromBase64 })
  .fromBase64;

/**
 * Base64 → bytes; null if malformed. Uint8Array.fromBase64 when the runtime
 * has it (native, ~0.5 ms for 200 KB); else atob plus a copy (~20 ms for
 * 200 KB). `impl` (null: the atob path) is for tests.
 */
export function decodeBase64(
  s: string,
  impl: FromBase64 | null = native?.bind(Uint8Array) ?? null,
): Uint8Array | null {
  try {
    if (impl) return impl(s);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
