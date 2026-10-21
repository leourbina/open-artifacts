import { readFileSync, statSync } from "node:fs";

/**
 * Reads a credential for xt:live from a file, once (P5 rule): never from env
 * or argv, and only if the file is private to its owner (mode 0600 or
 * stricter), so a key can't leak through `ps`, CI logs or a shared file.
 */
export function readSecretFile(path: string): string {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077)
    throw new Error(
      `${path}: mode ${mode.toString(8).padStart(4, "0")} is wider than 0600; chmod 600 it`,
    );
  const v = readFileSync(path, "utf8").trim();
  if (!v) throw new Error(`${path} is empty`);
  return v;
}
