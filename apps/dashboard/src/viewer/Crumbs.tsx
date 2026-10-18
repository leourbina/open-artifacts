import { AppLink } from "../library/AppLink";

/** Wordmark plus breadcrumbs (D4 header). */
export function Crumbs({ title }: { title: string }) {
  return (
    <header className="oa-top">
      <AppLink href="/" className="oa-wordmark">
        Open Artifacts
      </AppLink>
      <nav className="oa-crumbs" aria-label="Breadcrumb">
        <AppLink href="/">Library</AppLink>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{title}</span>
      </nav>
    </header>
  );
}
