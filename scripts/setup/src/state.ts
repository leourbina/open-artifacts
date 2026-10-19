import { join } from "node:path";
import type { Fs } from "./cf.ts";

export type State = {
  name?: string;
  accountId?: string;
  appHost?: string;
  contentHost?: string;
  ownerEmail?: string;
  d1Id?: string;
  r2Bucket?: string;
  kvId?: string;
  accessAppId?: string;
  /** Set right after the app POST, cleared once recorded: an app with this id is ours. */
  pendingAccessAppId?: string;
  accessClientId?: string;
  teamDomain?: string;
  deployedVersion?: string;
  /** The setup-minted owner token row; the token itself is never stored. */
  ownerTokenId?: string;
  /** The selftest's private welcome artifact, updated in place on later runs. */
  welcomeArtifactId?: string;
  /** The user declined the optional ANALYTICS_TOKEN; don't ask again. */
  analyticsSkipped?: boolean;
  /** Browser Run binding on/off; absent means on. Set by --no-browser, kept across --upgrade. */
  browser?: boolean;
  /** Workers plan read by prereqs: free, paid, or unknown (unreadable). */
  plan?: "free" | "paid" | "unknown";
  /** The PLAN var last rendered into the Worker config (what /healthz reports). */
  planVar?: "free" | "paid";
  /** "Just you, or a team?": team turns the email step on. Absent means solo. */
  team?: boolean;
  /** send_email binding on/off; off for solo, --no-email, or a Free fallback. */
  email?: boolean;
  /** The Email Sending domain; EMAIL_FROM is noreply@ it. */
  emailDomain?: string;
};

/** `.openartifacts/state.json` under the repo root (gitignored). */
export const statePath = (root: string) =>
  join(root, ".openartifacts", "state.json");

export function readState(fs: Fs, root: string): State {
  const text = fs.read(statePath(root));
  return text ? (JSON.parse(text) as State) : {};
}

export function writeState(fs: Fs, root: string, state: State): void {
  fs.write(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
}
