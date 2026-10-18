import { test } from "@playwright/test";

// Both cases need `wrangler dev`, dev-login and the built @oa/runtime (B10-B12).
test.fixme("db-capable HTML artifact sets/gets a doc via window.openArtifacts and it persists after reload", async () => {});

test.fixme("viewer iframe has the exact sandbox attribute", async () => {
  // expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals allow-downloads")
});
