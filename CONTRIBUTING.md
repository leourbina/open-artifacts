# Contributing

Rules for everyone working in this repo, people and agents alike.

## Git

- **Never use `git stash`.** The stash is shared by every worktree of a clone, so a
  `pop` in one worktree can apply or drop someone else's work. Commit work in progress
  to your own branch instead.
- One task per branch and PR. Branch from an up-to-date `origin/main`.
- Never force-push.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`docs:`, `ci:`, `test:`, `chore:`; add `!` for breaking changes). release-please uses
them to build the changelog and choose the next version.

## Merging

- `main` merges through the merge queue: `gh pr merge <number> --squash --auto`.
  The queue re-runs the required checks (lint, typecheck, test, build, e2e) on top of
  `main` and squash-merges once they pass. You don't need to update your branch first.
- No admin bypass. If staging goes red after a merge, merges pause until it's green again.

## Releases

release-please opens a release PR that only bumps versions: `CHANGELOG.md`, `.release-please-manifest.json`, and the `"version"` field of `package.json` files. Such a PR, and its merge-queue run, takes a fast path: the `changes` job runs `scripts/ci/release-only.ts` on the base and head commits, and when every changed file is one of those (a `package.json` counts only if `"version"` is the sole key that differs, and a rename or delete never counts) the required checks still report but skip their heavy steps, so they finish in about a minute instead of nine. This is safe because main already passed full CI at the commit the release PR is based on, and the PR changes no code, scripts or dependencies; `lint` still runs in full, including a check that the root version, the manifest and the top changelog heading agree. The decision uses only the script's output, never a label, branch name or author, and any other file in the diff (or any doubt, such as an unknown commit) means full CI. Push events and every other PR are unchanged.
