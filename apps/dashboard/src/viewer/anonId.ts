/**
 * The signed anonymous-id token ("<id>.<iat>.<sig>"; the legacy 2-part v1
 * "<id>.<sig>" is still accepted until the server renews it) for this browser on this
 * instance. One localStorage key on the app origin (each instance has its
 * own); with storage blocked (private mode, partitioned or disabled) it lives
 * in memory for the session. Never throws. The token stays in the shell: it is
 * never posted into the artifact frame.
 */
export const ANON_ID_KEY = "oa.anonId";
const TOKEN_RE = /^[A-Za-z0-9_-]{22}\.(?:[0-9a-z]{1,10}\.)?[A-Za-z0-9_-]{43}$/;

let memory: string | null = null;

export const isAnonToken = (v: unknown): v is string =>
  typeof v === "string" && TOKEN_RE.test(v);

export function loadAnonToken(): string | null {
  try {
    const v = localStorage.getItem(ANON_ID_KEY);
    if (isAnonToken(v)) return v;
  } catch {
    // Storage blocked: fall back to memory.
  }
  return memory;
}

export function saveAnonToken(token: string): void {
  if (!isAnonToken(token)) return;
  memory = token;
  try {
    localStorage.setItem(ANON_ID_KEY, token);
  } catch {
    // Storage blocked: memory only.
  }
}

/** Tests only. */
export const resetAnonMemory = () => {
  memory = null;
};
