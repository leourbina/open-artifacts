/**
 * Demo ops Worker: once a minute, read activity from the demo source artifacts and
 * write an aggregate into the dashboard artifact's data through the owner API.
 * It serves nothing (fetch is always 404) and reads only ids in SOURCE_ARTIFACT_IDS.
 */

export interface Env {
  /** Secret: owner PAT for the demo instance. Never logged. */
  DEMO_OA_TOKEN: string;
  DEMO_BASE_URL: string;
  DASHBOARD_ARTIFACT_ID: string;
  /** Comma-separated artifact ids. */
  SOURCE_ARTIFACT_IDS: string;
}

/** TODO: Frontend and Design define the real dashboard schema; keep this minimal. */
export interface DemoAggregate {
  /** Activity count per source artifact id. */
  counts: Record<string, number>;
  updatedAt: string;
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const parseIds = (raw: string): string[] => {
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id) continue;
    if (!ID_RE.test(id)) {
      console.warn("demo-ops: ignoring invalid source id");
      continue;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
};

/**
 * TODO: the source read shape is an assumption (`GET /api/v1/artifacts/:id/data`);
 * align with Backend's #298. Count = items in a list, else top-level keys.
 */
const countOf = (body: unknown): number => {
  if (Array.isArray(body)) return body.length;
  if (body && typeof body === "object") {
    const items = (body as { items?: unknown }).items;
    if (Array.isArray(items)) return items.length;
    return Object.keys(body).length;
  }
  return 0;
};

async function tick(env: Env): Promise<void> {
  if (!ID_RE.test(env.DASHBOARD_ARTIFACT_ID)) {
    console.error("demo-ops: invalid DASHBOARD_ARTIFACT_ID");
    return;
  }
  const base = env.DEMO_BASE_URL.replace(/\/+$/, "");
  const headers = {
    authorization: `Bearer ${env.DEMO_OA_TOKEN}`,
    "content-type": "application/json",
  };
  const counts: Record<string, number> = {};
  for (const id of parseIds(env.SOURCE_ARTIFACT_IDS)) {
    try {
      const res = await fetch(`${base}/api/v1/artifacts/${id}/data`, {
        method: "GET",
        headers,
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      counts[id] = countOf(await res.json());
    } catch (e) {
      console.warn(
        `demo-ops: skipping source ${id}: ${e instanceof Error ? e.message : "error"}`,
      );
    }
  }
  const aggregate: DemoAggregate = {
    counts,
    updatedAt: new Date().toISOString(),
  };
  const res = await fetch(
    `${base}/api/v1/artifacts/${env.DASHBOARD_ARTIFACT_ID}/data`,
    { method: "PUT", headers, body: JSON.stringify(aggregate) },
  );
  if (!res.ok) console.error(`demo-ops: dashboard write failed: ${res.status}`);
}

export default {
  async scheduled(_c: unknown, env: Env, _ctx: unknown): Promise<void> {
    await tick(env);
  },
  fetch(): Response {
    return new Response("not found", { status: 404 });
  },
};
