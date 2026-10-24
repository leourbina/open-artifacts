import { isInstallId, names, type Env as OaEnv } from "@oa/provision/names";

export interface Env {
  DISPATCHER: DispatchNamespace;
  /** host -> install id, written by provisioning (create and delete). */
  HOSTS: KVNamespace;
  OA_ENV: OaEnv;
}

// IPv4 dotted quad, or IPv6 (URL.hostname keeps the brackets: "[::1]").
const IP_LITERAL = /^(?:\d+(?:\.\d+){3}|\[.*\])$/;

/** The lookup key, or null for a host no install can hold. */
function hostOf(req: Request): string | null {
  let host: string;
  try {
    // URL.hostname drops the port; no other header (X-Forwarded-Host) counts.
    host = new URL(req.url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  // Tenant hosts are <slug>.<zone>: a bare apex, a single label, www (a
  // reserved slug) or an IP literal is never in HOSTS, so skip the read.
  if (IP_LITERAL.test(host) || host.split(".").length < 3) return null;
  return host.startsWith("www.") ? null : host;
}

/**
 * Every failure is this one response: a miss, a bad value, a binding error or
 * a deleted script look the same, and nothing reaches another install.
 */
const notFound = () => new Response("Not found", { status: 404 });

export default {
  async fetch(req, env) {
    const host = hostOf(req);
    if (!host) return notFound();
    try {
      const id = await env.HOSTS.get(host, { cacheTtl: 60 });
      if (typeof id !== "string" || !isInstallId(id)) return notFound();
      // The original Request, unread and unchanged (body, Upgrade, Cookie).
      return await env.DISPATCHER.get(names(id, env.OA_ENV).script).fetch(req);
    } catch {
      // The host only: never the URL, headers, body or the error text.
      console.error("dispatch failed", host);
      return notFound();
    }
  },
} satisfies ExportedHandler<Env>;
