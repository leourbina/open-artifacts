import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

/**
 * Reads a credential for xt:live from a file, once (P5 rule): never from env
 * or argv. The file is opened without following a symlink (O_NOFOLLOW) and
 * without blocking on a FIFO (O_NONBLOCK); then, on that same fd, it must be
 * a regular file owned by this process's uid with no group or other bits
 * (0600 or stricter). The secret is read from the fd, so nothing can swap the
 * file between the check and the read. Errors name the path, never content.
 */
export function readSecretFile(path: string, o: { uid?: number } = {}): string {
  const uid = o.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("readSecretFile needs a POSIX uid");
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "error";
    throw new Error(`${path}: is a symlink or unreadable (${code})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path}: not a regular file`);
    if (st.uid !== uid) throw new Error(`${path}: not owned by uid ${uid}`);
    const mode = st.mode & 0o777;
    if (mode & 0o077)
      throw new Error(
        `${path}: mode ${mode.toString(8).padStart(4, "0")} is wider than 0600; chmod 600 it`,
      );
    const v = readFileSync(fd, "utf8").trim();
    if (!v) throw new Error(`${path} is empty`);
    return v;
  } finally {
    closeSync(fd);
  }
}
