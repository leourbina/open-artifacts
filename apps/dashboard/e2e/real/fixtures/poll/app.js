/* Journey poll: votes live in the artifact's data store. */

const $ = (s) => document.querySelector(s);
let viewer = null;
let anon = 0;
/** Data ids are [A-Za-z0-9_-]; emails are not. */
const voterId = (email) => email.replace(/[^A-Za-z0-9_-]/g, "_");

async function render() {
  const page = await openArtifacts.db.collection("votes").list({ limit: 500 });
  const ul = $("#results");
  ul.textContent = "";
  for (const d of page.items) {
    const li = document.createElement("li");
    li.dataset.voter = d.id;
    li.textContent = `${d.id} voted ${d.data && d.data.choice}`;
    ul.appendChild(li);
  }
}

async function vote(choice) {
  $("#err").textContent = "";
  const id = viewer
    ? voterId(viewer.email)
    : `anon-${++anon}-${Date.now() % 100000}`;
  try {
    await openArtifacts.db.collection("votes").set(id, { choice });
    $("#status").textContent = `voted ${choice}`;
    await render();
  } catch (e) {
    $("#err").textContent = `vote failed: ${
      e && e.message ? e.message : String(e)
    }`;
  }
}

(async () => {
  await openArtifacts.ready;
  viewer = await openArtifacts.viewer.get();
  $("#who").textContent = viewer ? viewer.email : "anonymous";
  await render();
  openArtifacts.db.collection("votes").subscribe(() => {
    render();
  });
  for (const b of document.querySelectorAll("button.vote")) {
    b.addEventListener("click", () => vote(b.dataset.choice));
  }
})();
