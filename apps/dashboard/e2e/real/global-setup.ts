import { createServer } from "node:http";
import { APP, EMBEDDER_PORT, startServer } from "./fixtures";

/** EMBEDDER: frames `?src=`, only ever an APP /a/<id>/full. */
function startEmbedder(): Promise<() => Promise<void>> {
  const server = createServer((req, res) => {
    const src = new URL(req.url ?? "/", "http://x").searchParams.get("src");
    if (
      !src ||
      !/^\/a\/[A-Za-z0-9_-]+\/full$/.test(new URL(src, APP).pathname) ||
      new URL(src, APP).origin !== APP
    ) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(
        `<!doctype html><iframe id="app" src="${new URL(src, APP).href}" style="width:900px;height:600px"></iframe>`,
      );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(EMBEDDER_PORT, "127.0.0.1", () =>
      resolve(() => new Promise<void>((r) => server.close(() => r()))),
    );
  });
}

export default async function globalSetup() {
  const stopServer = await startServer();
  const stopEmbedder = await startEmbedder();
  return async () => {
    await stopEmbedder();
    await stopServer();
  };
}
