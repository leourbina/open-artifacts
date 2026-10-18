import { AUTH } from "@oa/shared";
import { Banner } from "@oa/ui";
import { useMe } from "../auth/useMe";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { EdgePanel } from "./Edge";

export function SignIn({ failed = false }: { failed?: boolean }) {
  useDocumentTitle("Sign in");
  const state = useMe();
  const name =
    (state.status === "authed" && state.me.instance.name) || "Open Artifacts";
  return (
    <EdgePanel>
      <h1>Sign in to {name}</h1>
      {failed && (
        <Banner tone="danger" title="Sign-in didn't finish.">
          The login link expired or was cancelled. Try again.
        </Banner>
      )}
      <div className="oa-actions">
        <a className="oa-btn oa-primary" href={AUTH.login}>
          Continue with Cloudflare Access
        </a>
      </div>
      <p className="oa-note">
        You'll confirm your email with a one-time PIN or your organization's
        login.
      </p>
    </EdgePanel>
  );
}
