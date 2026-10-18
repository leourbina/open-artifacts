const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_UNBIASED = 256 - (256 % 58); // 232: bytes >= this are rejected

function randomBase58(n: number): string {
  let out = "";
  const buf = new Uint8Array(Math.max(n * 2, 16));
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const b = buf[i] as number;
      if (b < MAX_UNBIASED) out += ALPHABET[b % 58];
    }
  }
  return out;
}

const ID_RE = /^[1-9A-HJ-NP-Za-km-z]{16}$/;
const PAT_RE = /^oa_pat_[1-9A-HJ-NP-Za-km-z]{32}$/;

export function newId(): string {
  return randomBase58(16);
}
export function isId(s: string): boolean {
  return ID_RE.test(s);
}
export function newPat(): string {
  return `oa_pat_${randomBase58(32)}`;
}
export function isPat(s: string): boolean {
  return PAT_RE.test(s);
}
