// Plain POSIX ustar, read in memory only (publishRelease, T3b): never
// extracted to disk. The release workflow writes regular files only, with
// no pax or GNU header (scripts/ci/release-artifact.ts packUstar).
import { ASSET_LIMITS, assertAssetPath, type ReleaseAsset } from "./release.js";

const BLOCK = 512;
const utf8 = new TextEncoder();

/** True when `path` fits a plain ustar header: name <= 100 bytes, or a prefix <= 155 and a name <= 100, split at "/". */
export function ustarFits(path: string): boolean {
  const b = utf8.encode(path);
  if (b.length <= 100) return true;
  for (let i = b.length - 1; i > 0; i--)
    if (
      b[i] === 0x2f &&
      i <= 155 &&
      b.length - i - 1 <= 100 &&
      b.length - i - 1 > 0
    )
      return true;
  return false;
}

const field = (h: Uint8Array, off: number, len: number): string => {
  const f = h.subarray(off, off + len);
  const end = f.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    end < 0 ? f : f.subarray(0, end),
  );
};

/** A NUL- or space-terminated octal field; anything else is refused. */
function octal(h: Uint8Array, off: number, len: number, what: string): number {
  const s = String.fromCharCode(...h.subarray(off, off + len));
  const m = /^ *([0-7]+)[ \0]*$/.exec(s);
  if (!m) throw new Error(`tar: bad ${what} field`);
  const n = Number.parseInt(m[1] as string, 8);
  if (!Number.isSafeInteger(n)) throw new Error(`tar: ${what} is too large`);
  return n;
}

/**
 * The regular files of a plain ustar archive. Refuses symlinks, hardlinks
 * and every type other than a regular file or a directory (pax and GNU
 * headers included), a non-ustar magic, a bad checksum, an absolute path,
 * "..", an empty or dot segment, a duplicate name, a file over 25 MiB, more
 * entries than ASSET_LIMITS allows, a truncated entry, a missing end of
 * archive and anything but zero padding after it.
 */
export function parseUstar(tar: Uint8Array): ReleaseAsset[] {
  if (tar.length % BLOCK !== 0)
    throw new Error("tar: length is not a multiple of 512 (trailing garbage)");
  const out: ReleaseAsset[] = [];
  const names = new Set<string>();
  let off = 0;
  let total = 0;
  for (;;) {
    if (off + BLOCK > tar.length)
      throw new Error("tar: no end-of-archive blocks (truncated)");
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      const next = tar.subarray(off + BLOCK, off + 2 * BLOCK);
      if (next.length !== BLOCK || !next.every((b) => b === 0))
        throw new Error("tar: no end-of-archive blocks (truncated)");
      if (!tar.subarray(off + 2 * BLOCK).every((b) => b === 0))
        throw new Error("tar: trailing garbage after the end of the archive");
      return out;
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++)
      sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
    if (octal(h, 148, 8, "checksum") !== sum)
      throw new Error("tar: bad header checksum");
    if (
      field(h, 257, 6) !== "ustar" ||
      h[262] !== 0 ||
      field(h, 263, 2) !== "00"
    )
      throw new Error("tar: not a plain ustar header (magic)");
    const type = String.fromCharCode(h[156] as number);
    if (type === "x" || type === "g" || type === "L" || type === "K")
      throw new Error(`tar: pax or GNU header (type ${type}) refused`);
    if (type !== "0" && type !== "\0" && type !== "5")
      throw new Error(
        `tar: entry type ${JSON.stringify(type)} refused (regular files and directories only)`,
      );
    const size = octal(h, 124, 12, "size");
    const prefix = field(h, 345, 155);
    const name = field(h, 0, 100);
    let path = prefix ? `${prefix}/${name}` : name;
    if (type === "5") path = path.replace(/\/$/, "");
    try {
      assertAssetPath(path);
    } catch {
      throw new Error(
        `tar: path ${JSON.stringify(path).slice(0, 80)} refused (absolute, "..", empty or dot segment)`,
      );
    }
    if (names.has(path)) throw new Error(`tar: ${path} appears twice`);
    names.add(path);
    if (names.size > ASSET_LIMITS.files + 1000)
      throw new Error("tar: more entries than ASSET_LIMITS allows");
    if (type === "5") {
      if (size !== 0) throw new Error(`tar: directory ${path} has a size`);
      off += BLOCK;
      continue;
    }
    if (size > ASSET_LIMITS.fileBytes)
      throw new Error(`tar: ${path} is over the 25 MiB limit`);
    total += size;
    if (total > ASSET_LIMITS.totalBytes + 128 * 1024 * 1024)
      throw new Error("tar: over the total size limit");
    const start = off + BLOCK;
    if (start + size > tar.length) throw new Error(`tar: ${path} is truncated`);
    out.push({ path, bytes: tar.slice(start, start + size) });
    off = start + Math.ceil(size / BLOCK) * BLOCK;
  }
}
