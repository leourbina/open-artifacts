// Static content host for the thumbnail bench (scripts/bench-thumbs.ts), in
// its own process so its CPU never counts as the capture's. Serves
//   /c/{token}/{id}/v{v}/{rest} → {dir}/{id}/v{v}/{rest} (prefetched from the
//                                 real content app, with its headers)
//   /_oa/{file}                 → the render / runtime dist (built)
// Usage: node bench-static.mjs <dir> <renderDist> <runtimeDist>; prints the port.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const [dir, renderDist, runtimeDist] = process.argv.slice(2);
const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".mjs": "text/javascript; charset=utf-8",
};
const SIGNED = /^\/c\/[^/]+\/([^/]+)\/(v\d+)\/(.*)$/s;

createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const m = SIGNED.exec(p);
  if (m) {
    const base = path.join(dir, m[1], m[2], m[3] || "__index");
    if (!existsSync(`${base}.body`)) return void res.writeHead(404).end();
    const { status, headers } = JSON.parse(
      readFileSync(`${base}.meta`, "utf8"),
    );
    res.writeHead(status, headers).end(readFileSync(`${base}.body`));
    return;
  }
  if (p.startsWith("/_oa/")) {
    const name = p.slice(5);
    for (const d of [renderDist, runtimeDist]) {
      const f = path.join(d, name);
      if (!name.includes("..") && existsSync(f)) {
        res
          .writeHead(200, {
            "content-type":
              TYPES[path.extname(f)] ?? "application/octet-stream",
            "access-control-allow-origin": "*",
          })
          .end(readFileSync(f));
        return;
      }
    }
  }
  res.writeHead(404).end();
}).listen(0, "127.0.0.1", function () {
  process.stdout.write(`${this.address().port}\n`);
});
