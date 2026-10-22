// Test and tooling helper: reads the checkout's server template. Deliberately
// not exported from the package index; the provisioner takes the release's own
// template and must never read the checkout.
import { readFileSync } from "node:fs";
import { parseTemplate, type Template } from "../metadata.js";

let cached: Template | undefined;
export function loadTemplate(): Template {
  cached ??= parseTemplate(
    readFileSync(
      new URL(
        "../../../../apps/server/wrangler.template.jsonc",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return cached;
}
