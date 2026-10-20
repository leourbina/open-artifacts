/**
 * The sandbox tokens for an artifact: the content host's CSP `sandbox`
 * directive and the viewer iframe's `sandbox` attribute. Popups may escape the
 * sandbox (new-tab links); `allow-same-origin` and `allow-top-navigation*` are
 * never granted, so an artifact can't navigate the viewer page.
 */
export const ARTIFACT_SANDBOX = [
  "allow-scripts",
  "allow-forms",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-modals",
  "allow-downloads",
] as const;

/** ARTIFACT_SANDBOX as a space-separated `sandbox` value. */
export const ARTIFACT_SANDBOX_ATTR = ARTIFACT_SANDBOX.join(" ");
