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
};
export type Ctx = {
  deps: Deps;
  fs: Fs;
  root: string;
  opts: Opts;
  api: Api;
  wrangler: Wrangler;
};
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
