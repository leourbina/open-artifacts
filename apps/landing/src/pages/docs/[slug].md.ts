import type { APIRoute, GetStaticPaths } from "astro";
import { type Doc, docMarkdown, docs } from "../../lib/llms";

export const getStaticPaths = (async () =>
  (await docs()).map((doc) => ({
    params: { slug: doc.id },
    props: { doc },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ doc: Doc }> = ({ props }) =>
  new Response(docMarkdown(props.doc), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
