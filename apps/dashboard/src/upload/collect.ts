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

/** Without entries a dropped folder shows up as an extension-less, typeless 4 KB-multiple "file". */
const looksLikeDir = (f: File) =>
  f.type === "" && !f.name.includes(".") && f.size % 4096 === 0;

const byPath = (a: File, b: File) =>
  (a.webkitRelativePath || a.name).localeCompare(
    b.webkitRelativePath || b.name,
  );

/** Files from a drop, recursing into dropped folders. Call synchronously from the drop event. */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const items = [...dt.items].filter((i) => i.kind === "file");
  if (items.length === 0 || !items[0]?.webkitGetAsEntry)
    return filterIgnored([...dt.files].filter((f) => !looksLikeDir(f))).sort(
      byPath,
    );
  // Entries must be taken before the first await; the DataTransfer empties after the event.
  const picked = items.map((i) => ({
    entry: i.webkitGetAsEntry?.() ?? null,
    file: i.getAsFile(),
  }));
  const out: File[] = [];
  for (const { entry, file } of picked) {
    if (entry) await walk(entry, out);
    else if (file && !isIgnored(file.name)) out.push(file);
  }
  return out.sort(byPath);
}

/** Files from a picker (webkitRelativePath already set for folders). */
export const filterIgnored = (files: File[]) =>
  files.filter((f) => !isIgnored(f.webkitRelativePath || f.name)).sort(byPath);
