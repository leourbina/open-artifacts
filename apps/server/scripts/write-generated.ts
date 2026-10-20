// Writes a generated file only when its content changed, via a temp file and
// rename, so parallel runs (pnpm -r test, the landing build) never read it torn.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function writeGenerated(file: string, content: string): void {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}
