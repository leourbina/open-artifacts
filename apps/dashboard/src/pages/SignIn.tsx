import { AUTH } from "@oa/shared";
import { Banner } from "@oa/ui";
import { brand } from "@oa/ui/brand";
import { Button, Separator } from "@oa/ui/shadcn";
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
      <img className={`oa-lt ${className ?? ""}`} src={light} alt="" />
      <img className={`oa-dk ${className ?? ""}`} src={dark} alt="" />
    </>
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
        <Themed
          light={brand.markLight}
          dark={brand.markDark}
          className="oa-split-mark"
        />
      </section>
      <section className="oa-split-form">
        <div className="oa-split-formbox">
          <h1>Sign in</h1>
          <p>Use your work email to open {name}.</p>
          {failed && (
            <Banner tone="danger" title="Sign-in didn't finish.">
              The login link expired or was cancelled. Try again.
            </Banner>
          )}
          <Button asChild size="lg" className="oa-split-btn">
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
          <Separator />
          <p className="oa-note">
            You'll confirm your email with a one-time PIN or your organization's
            login.
          </p>
        </div>
      </section>
    </div>
  );
}
