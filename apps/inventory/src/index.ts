interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] }>;
    };
    all(): Promise<{ results?: unknown[] }>;
  };
}

export interface Env {
  PLATFORM_DB: D1Like;
  /** Secret. Not listed in wrangler.jsonc. */
  INVENTORY_KEY?: string;
}

interface Row {
  id: string;
  app_host: string;
  content_host: string;
  state: string;
  test_hooks: number;
}

const SQL =
  "SELECT id, app_host, content_host, state, test_hooks FROM installs ORDER BY id";

const notFound = () => new Response("Not found", { status: 404 });

async function sha256(s: string): Promise<Uint8Array> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(d);
}

async function keyMatches(
  presented: string,
  expected: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = env.INVENTORY_KEY;
    if (typeof key !== "string" || key.length < 32) return notFound();
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/installs")
      return notFound();
    const m = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");
    if (!m || !(await keyMatches(m[1], key))) return notFound();

    const { results } = await env.PLATFORM_DB.prepare(SQL).all();
    const installs = ((results ?? []) as Row[]).map((r) => ({
      id: r.id,
      appHost: r.app_host,
      contentHost: r.content_host,
      state: r.state,
      testHooks: Boolean(r.test_hooks),
    }));
    return new Response(JSON.stringify({ installs }), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  },
};
