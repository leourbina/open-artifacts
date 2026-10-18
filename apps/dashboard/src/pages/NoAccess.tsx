import { AUTH } from "@oa/shared";
import { api } from "../api/client";
import { useRedirect } from "../auth/redirect";
import { EdgePanel, SignedInAs } from "./Edge";

export function NoAccess() {
  const redirect = useRedirect();
  const signOut = async () => {
    try {
      await api.send("POST", AUTH.logout, undefined);
    } finally {
      redirect(AUTH.login);
    }
  };
  return (
    <EdgePanel>
      <h1>You're signed in, but there's nothing here for you yet</h1>
      <p>
        This account isn't a member of this instance, and no artifacts have been
        shared with it.
      </p>
      <p>
        If you expected access, ask the person who sent you the link to share it
        with this email, or ask an admin to invite you.
      </p>
      <SignedInAs />
      <div className="oa-actions">
        <a className="oa-btn oa-primary" href={AUTH.login}>
          Sign in as someone else
        </a>
        <button type="button" className="oa-btn" onClick={signOut}>
          Sign out
        </button>
      </div>
    </EdgePanel>
  );
}
