// The instance version rule, kept pure (no git, no fs) so tests pin it.
// A release build is one whose HEAD carries the tag v<version> (release-please
// tags vX.Y.Z and bumps the root package.json in the same commit); it reports
// <version>. Anything else reports <version>-dev+<short sha>, or <version>-dev
// without git, so a build from main or a fork never reads as the release.

export type VersionInput = {
  /** Root package.json `version`. */
  version: string;
  /** Tags pointing at HEAD; null when git is unavailable. */
  tags: string[] | null;
  /** Short HEAD sha; null when git is unavailable. */
  sha: string | null;
};

export function instanceVersion({ version, tags, sha }: VersionInput): string {
  if (sha && tags?.includes(`v${version}`)) return version;
  return sha ? `${version}-dev+${sha}` : `${version}-dev`;
}
