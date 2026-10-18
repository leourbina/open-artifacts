import { AUTH } from "@oa/shared";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { EdgePanel, SignedInAs } from "./Edge";

/** Also what an inaccessible artifact shows, so the copy never says whether it exists. */
export function NotFound() {
  useDocumentTitle("Not found");
  return (
    <EdgePanel>
      <p className="oa-eyebrow">404</p>
      <h1>Page not found</h1>
      <p>
        There's nothing at this address for the account you're using. The link
        may be mistyped, or it may need a different account.
      </p>
      <SignedInAs />
      <div className="oa-actions">
        <a className="oa-btn oa-primary" href="/">
          Go to library
        </a>
        <a className="oa-btn" href={AUTH.login}>
          Switch account
        </a>
      </div>
    </EdgePanel>
  );
}
