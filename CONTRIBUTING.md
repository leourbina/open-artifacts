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

release-please opens a release PR that only bumps versions: `CHANGELOG.md`, `.release-please-manifest.json`, and the `"version"` field of `package.json` files. Such a PR, and its merge-queue run, takes a fast path. There is no separate job: `typecheck`, `test`, `build` and `e2e` each start with a full checkout and a `release-only` step that copies `scripts/ci/release-only.ts` out of the **base** commit (never the code under test) and runs it on the base and head. When every changed file is a release file (a `package.json` counts only if a semver `"version"` is the sole key that differs; a rename or delete never counts), the job still runs and reports, but skips its heavy steps, so the required checks finish in about a minute instead of nine. Any error, a script missing at the base (the first rollout), or any output other than exactly `release-only` means full CI. This is safe because the base commit is on main, which only the merge queue can update, and the PR changes no code, scripts or dependencies; the job doesn't claim CI passed, only that nothing needing it changed. `lint` always runs in full, including a check that the root version, the manifest and the first `## ` heading in `CHANGELOG.md` agree. The decision uses only the script's output, never a label, branch name or author. Push events and every other PR are unchanged.
