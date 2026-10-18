import { isIgnored } from "./uploadPipeline";

const withPath = (file: File, path: string): File => {
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
};

const readAll = (reader: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });

async function walk(entry: FileSystemEntry, out: File[]): Promise<void> {
  // Dot-folders (.git) are skipped without descending into them.
  if (entry.isDirectory && entry.name.startsWith(".")) return;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) =>
      (entry as FileSystemFileEntry).file(res, rej),
    );
    const path = entry.fullPath.replace(/^\//, "");
    if (!isIgnored(path))
      out.push(path.includes("/") ? withPath(file, path) : file);
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (const child of await readAll(reader)) await walk(child, out);
  }
}

/** Files from a drop, recursing into dropped folders. Call synchronously from the drop event. */
export function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items]
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.() ?? null);
  if (entries.length === 0 || entries.some((e) => e === null))
    return Promise.resolve(filterIgnored([...dt.files]));
  const out: File[] = [];
  return Promise.all(
    (entries as FileSystemEntry[]).map((e) => walk(e, out)),
  ).then(() => out);
}

/** Files from a picker (webkitRelativePath already set for folders). */
export const filterIgnored = (files: File[]) =>
  files.filter((f) => !isIgnored(f.webkitRelativePath || f.name));
