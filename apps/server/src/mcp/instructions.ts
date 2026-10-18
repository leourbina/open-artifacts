// Server instructions, also served as the resource RUNTIME_DOC_URI. Vendor-neutral.

export const RUNTIME_DOC_URI = "openartifacts://docs/runtime";

export const INSTRUCTIONS = `Open Artifacts hosts the pages, documents and code you publish, with versions, sharing and live data.

Formats
- html: a web page or a small site. Scripts run in a sandboxed iframe on a separate origin.
- markdown: rendered with code highlighting and mermaid diagrams.
- code: one source file shown with syntax highlighting; set language (for example "python").
- pdf: an uploaded PDF document.
- If format is omitted it is inferred from the entry file's extension.

Publishing
- One file: publish_artifact { title, format, content }.
- Several files: publish_artifact { title, entry: "index.html", files: { "index.html": "...", "app.js": "...", "img/logo.png": { "base64": "..." } } }.
- Paths are relative, use "/" and are case-sensitive; link between files with relative URLs.
- Text files are plain strings; binary files are { "base64": "..." }.
- To publish a new version, pass the artifact's id; every publish creates a version and the URL stays the same.
- Add a short message describing the change. Visibility defaults to private.

Large files
- Inline content (content, text files and base64 together) is limited to 256 KB per call; over it, publish_artifact fails with too_large. For anything larger (up to 25 MB per file), upload each large file:
  1. create_upload { path, size, contentType, artifactId? } returns { uploadId, artifactId, url }. Omit artifactId for a new artifact and reuse the returned artifactId for every other file.
  2. PUT the raw bytes to url (valid 1 hour).
  3. publish_artifact { id: artifactId, title, entry, files: { "<path>": { "uploadId": "<uploadId>" }, ... } }; small files can stay inline next to uploaded ones.

Reading
- get_artifact returns metadata and, for text files up to 1 MB, the content; otherwise a downloadUrl valid for 10 minutes.
- list_artifacts, search_artifacts and list_versions page with cursor; restore_version publishes an old version again.

Live data (html artifacts)
- Declare capabilities when publishing: capabilities: { db: true, viewer: true, storage: true }.
  - db: a shared document store every viewer sees, updated live.
  - viewer: the signed-in viewer's email and name.
  - storage: private per-viewer key/value storage.
- Undeclared calls fail with capability_denied. allowAnonymousWrites: true lets anonymous viewers of public artifacts write (rate-limited).
- Limits: 1 MB per document, 50 MB per artifact, 100 writes per minute per viewer.
- The artifact_data_* tools read and write the same db collections; documents are JSON objects.

window.openArtifacts (available inside published html)
- await openArtifacts.ready
- openArtifacts.viewer.get() → { email, name } or null
- openArtifacts.db.collection(name): get(id), list({ cursor, limit }), query({ where, orderBy, order, limit }),
  set(id, data), update(id, patch), delete(id), subscribe(cb) → unsubscribe
  subscribe(cb) gets { docs, deleted, resync? }: after a reconnect it gets { docs: [], deleted: [], resync: true };
  refetch your data when resync is true.
- openArtifacts.storage: get(key), set(key, value), delete(key), list()
- openArtifacts.theme ("light" | "dark") and onTheme(cb)

Example: a live poll (publish with capabilities: { db: true, viewer: true })
<button data-choice="yes">Yes</button> <button data-choice="no">No</button> <p id="out"></p>
<script>
  const votes = openArtifacts.db.collection("votes");
  async function render() {
    const { items } = await votes.list();
    out.textContent = items.filter((d) => d.data.choice === "yes").length + " yes / " + items.length + " total";
  }
  document.querySelectorAll("button").forEach((b) => b.onclick = async () => {
    const me = await openArtifacts.viewer.get();
    await votes.set(me ? me.email.replace(/[^A-Za-z0-9_-]/g, "_") : "anon", { choice: b.dataset.choice });
  });
  openArtifacts.ready.then(render); votes.subscribe(render);
</script>

Errors
- Results with isError carry "<code>: <message>". not_found also means you lack access.
- quota_exceeded means the instance hit its daily free-plan limit; retry after 00:00 UTC.
`;
