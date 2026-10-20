// The client snippets live in @oa/shared (agentClients), shared with the
// server's /skill.md. Re-exported under the dashboard's names.
import { hostSlug, SECRET_LABELS, secretFile, secretSnippet } from "@oa/shared";

export {
  agentClients as snippets,
  type Snippet,
  TOKEN_PLACEHOLDER,
} from "@oa/shared";

/** This instance's PAT file; token snippets read it at connect time (an env
    var isn't visible to agents running as background services). */
export const tokenFile = () =>
  secretFile("pat", { hostSlug: hostSlug(location.host) });

/** The hidden-input line that saves a pasted token to tokenFile(). */
export const saveTokenCommand = () =>
  secretSnippet(tokenFile(), SECRET_LABELS.pat);
