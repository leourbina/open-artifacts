import { AUTH } from "@oa/shared";
import { Banner } from "@oa/ui";
import { brand } from "@oa/ui/brand";
import { Button } from "@oa/ui/shadcn";
import { useDocumentTitle, useInstanceName } from "../layout/useDocumentTitle";

/** Light and dark variants of one brand image; CSS shows the matching one. */
function Themed({
  light,
  dark,
  className,
}: {
  light: string;
  dark: string;
  className?: string;
}) {
  return (
    <>
      <img
        className={`oa-lt ${className ?? ""}`}
        src={light}
        alt=""
        aria-hidden="true"
      />
      <img
        className={`oa-dk ${className ?? ""}`}
        src={dark}
        alt=""
        aria-hidden="true"
      />
    </>
  );
}

/** The bare mark (paths from the brand logo): frame in text ink, accent in the brand accent. */
function Mark({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="var(--oa-text)"
        d="M22 2H5a3 3 0 0 0-3 3v17l4 4V6h20zM10 30h17a3 3 0 0 0 3-3V10l-4-4v20H6z"
      />
      <path
        fill="var(--oa-accent)"
        d="M22 2h5a3 3 0 0 1 3 3v5zM2 22v5a3 3 0 0 0 3 3h5zM11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"
      />
    </svg>
  );
}

/** Split brand panel: pitch on the left, sign-in form on the right. */
export function SignIn({ failed = false }: { failed?: boolean }) {
  useDocumentTitle("Sign in");
  const name = useInstanceName();
  return (
    <div className="oa-split">
      <section className="oa-split-brand">
        <div className="oa-split-logo">
          <Themed light={brand.logo} dark={brand.logoDark} />
        </div>
        <div className="oa-split-pitch">
          <h2>Where any AI agent publishes for your team.</h2>
          <p>
            Pages, docs, code and PDFs, private by default and shared when you
            choose.
          </p>
        </div>
        <small className="oa-split-foot">Self-hosted on Cloudflare</small>
        <Mark className="oa-split-mark" />
      </section>
      <section className="oa-split-form">
        <div className="oa-split-formbox">
          <Mark className="oa-split-formmark" />
          <h1>Sign in</h1>
          <p className="oa-split-sub">Use your work email to open {name}.</p>
          {failed && (
            <Banner tone="danger" title="Sign-in didn't finish.">
              The login link expired or was cancelled. Try again.
            </Banner>
          )}
          <Button asChild className="oa-split-btn">
            <a href={AUTH.login}>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="7.5" cy="15.5" r="4.5" />
                <path d="m10.7 12.3 9.3-9.3M16 7l3 3M14 9l2 2" />
              </svg>
              Continue with Cloudflare Access
            </a>
          </Button>
          <p className="oa-note">
            You'll confirm your email with a one-time PIN or your organization's
            login.
          </p>
        </div>
      </section>
    </div>
  );
}
