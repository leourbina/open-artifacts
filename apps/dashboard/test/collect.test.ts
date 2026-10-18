// filesFromDrop's folder recursion (webkitGetAsEntry), which e2e can't reach:
// browsers don't let a script build a DataTransfer holding a directory.
import { describe, expect, it } from "vitest";
import { filesFromDrop } from "../src/upload/collect";

type Node = string | { [name: string]: Node };

/** A FileSystemEntry tree; readEntries hands out children in batches of 2, like Chrome's 100. */
function entry(name: string, node: Node, parent = ""): FileSystemEntry {
  const fullPath = `${parent}/${name}`;
  if (typeof node === "string")
    return {
      isFile: true,
      isDirectory: false,
      name,
      fullPath,
      file: (ok: (f: File) => void) => ok(new File([node], name)),
    } as unknown as FileSystemEntry;
  const kids = Object.entries(node).map(([n, c]) => entry(n, c, fullPath));
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    createReader: () => {
      let i = 0;
      return {
        readEntries: (ok: (b: FileSystemEntry[]) => void) => {
          const batch = kids.slice(i, i + 2);
          i += 2;
          queueMicrotask(() => ok(batch)); // async, as in browsers
        },
      };
    },
  } as unknown as FileSystemEntry;
}

const drop = (tree: Record<string, Node>) =>
  ({
    items: Object.entries(tree).map(([name, node]) => ({
      kind: "file",
      webkitGetAsEntry: () => entry(name, node),
      getAsFile: () => null,
    })),
    files: [],
  }) as unknown as DataTransfer;

const paths = (files: File[]) =>
  files.map((f) => f.webkitRelativePath || f.name);

describe("filesFromDrop", () => {
  it("recurses into a dropped folder, keeping folder-relative paths", async () => {
    const files = await filesFromDrop(
      drop({
        site: {
          "index.html": "<h1>x</h1>",
          "style.css": "h1{}",
          css: { "a.css": "", "b.css": "", deep: { "c.css": "" } },
        },
      }),
    );
    expect(paths(files)).toEqual([
      "site/css/a.css",
      "site/css/b.css",
      "site/css/deep/c.css",
      "site/index.html",
      "site/style.css",
    ]);
  });

  it("skips dot-folders and OS junk", async () => {
    const files = await filesFromDrop(
      drop({
        site: {
          ".git": { HEAD: "ref" },
          ".DS_Store": "",
          "index.html": "",
        },
      }),
    );
    expect(paths(files)).toEqual(["site/index.html"]);
  });

  it("keeps a top-level file's bare name", async () => {
    const files = await filesFromDrop(drop({ "notes.md": "# hi" }));
    expect(paths(files)).toEqual(["notes.md"]);
  });
});
