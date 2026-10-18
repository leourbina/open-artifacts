import type { Api, Deps, Fs, Wrangler } from "./cf.ts";
import type { State } from "./state.ts";

export type Opts = {
  name: string;
  appHost: string;
  contentHost: string;
  ownerEmail: string;
  accountId?: string;
  yes: boolean;
  upgrade: boolean;
  /** Read-only: run every check(), never apply, write nothing. */
  check: boolean;
  newOwnerToken: boolean;
  /** False under --yes or --json: never prompt. */
  interactive: boolean;
  json: boolean;
};
export type Ctx = {
  deps: Deps;
  fs: Fs;
  root: string;
  opts: Opts;
  api: Api;
  /** Access API client: OA_ACCESS_TOKEN, else the wrangler token. */
  accessApi: Api;
  wrangler: Wrangler;
  /** Notes appended to the current step's reported message. */
  notes: string[];
  /** `data` for the current step's line; `human` replaces it in human output. */
  data?: unknown;
  human?: string;
  /** The PAT minted this run, in memory only. */
  pat?: string;
  /** The welcome artifact's view URL, when selftest published it this run. */
  welcomeUrl?: string;
  /** Saved state as loaded, before this run's flags were applied. */
  prev?: { name?: string; appHost?: string; accountId?: string };
};

/** Missing input where prompting isn't allowed (--json): reported as action_required, exit 2. */
export class NeedInput extends Error {}
export type ActionRequired = {
  status: "action_required";
  message: string;
  data?: unknown;
};
export type Step = {
  name: string;
  check: (state: State, ctx: Ctx) => Promise<"done" | "todo">;
  apply: (state: State, ctx: Ctx) => Promise<ActionRequired | undefined>;
};
