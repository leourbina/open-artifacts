import { R } from "@oa/shared";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;

async function attempt(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn("smoke warm-up: retrying", (e as Error).message);
    await fn();
  }
}

/** Warms a just-deployed Worker (healthz, then one publish) before the smoke suite. */
export default async function warmup(): Promise<void> {
  if (!base) return;
  await attempt(async () => {
    const r = await fetch(`${base}/healthz`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`healthz ${r.status}`);
  });
  if (!pat) return;
  const auth = { authorization: `Bearer ${pat}` };
  let id: string | undefined;
  await attempt(async () => {
    const r = await fetch(`${base}${R.artifacts}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        title: `smoke warm-up ${new Date().toISOString()}`,
        format: "markdown",
        content: "# warm-up\n",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status !== 201) throw new Error(`publish ${r.status}`);
    id = ((await r.json()) as { id: string }).id;
  });
  if (id)
    await fetch(`${base}${R.artifact(id)}`, { method: "DELETE", headers: auth })
      .then((d) => {
        if (d.status !== 204)
          console.warn(`smoke warm-up: DELETE ${id} -> ${d.status}`);
      })
      .catch(() => console.warn(`smoke warm-up: DELETE ${id} failed`));
}
