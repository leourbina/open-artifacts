import { defineCollection } from "astro:content";
import { REPO_URL } from "@oa/shared";
import { glob, type Loader } from "astro/loaders";
import { z } from "astro/zod";

// Docs write {REPO_URL} so the repo URL is defined only in @oa/shared.
// This wraps the glob loader to fill it in before rendering.
function docsLoader(): Loader {
  const base = glob({ pattern: "*.md", base: "./src/content/docs" });
  return {
    name: "docs",
    async load(ctx) {
      const pending: Promise<unknown>[] = [];
      const store = new Proxy(ctx.store, {
        get(target, key, receiver) {
          if (key !== "set") return Reflect.get(target, key, receiver);
          return (entry: Parameters<typeof target.set>[0]) => {
            if (!entry.body?.includes("{REPO_URL}")) return target.set(entry);
            const body = entry.body.replaceAll("{REPO_URL}", REPO_URL);
            pending.push(
              ctx
                .renderMarkdown(body)
                .then((rendered) => target.set({ ...entry, body, rendered })),
            );
            return true;
          };
        },
      });
      await base.load({ ...ctx, store });
      await Promise.all(pending);
    },
  };
}

const docs = defineCollection({
  loader: docsLoader(),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number(),
  }),
});

export const collections = { docs };
