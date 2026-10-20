// The parent shell may hold real secrets: no test may see or print them.
for (const k of Object.keys(process.env))
  if (
    k === "OA_TOKEN" ||
    k === "OA_ACCESS_TOKEN" ||
    k === "ANALYTICS_TOKEN" ||
    k.startsWith("CLOUDFLARE_")
  )
    delete process.env[k];
