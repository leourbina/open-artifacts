import type { APIRoute } from "astro";
import { docMarkdown, docs, SUMMARY } from "../lib/llms";

export const GET: APIRoute = async () => {
  const pages = (await docs()).map(docMarkdown);
  const body = [`# Open Artifacts\n\n> ${SUMMARY}\n`, ...pages].join(
    "\n---\n\n",
  );
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
