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
  accessClientId?: string;
  teamDomain?: string;
  deployedVersion?: string;
  /** The user declined the optional ANALYTICS_TOKEN; don't ask again. */
  analyticsSkipped?: boolean;
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
