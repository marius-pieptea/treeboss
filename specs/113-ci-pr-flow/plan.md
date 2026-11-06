# Implementation Plan: CI workflow and pull requests from sessions

**Feature**: `113-ci-pr-flow` | **Spec**: [spec.md](./spec.md)

## Summary

`src/ci/workflow.ts` reads the project (lockfile, manifests, Playwright config) and renders `.github/workflows/ci.yml`. It takes its verify commands from `src/verify/detect.ts`. `src/ci/pr.ts` wraps `gh` with argv arrays through an injectable runner, keeps `session_prs`, and turns a session's worktree branch into a PR. Routes, a CLI pair (`trb pr`, `trb ci`) and a web feature (`web/src/features/ci/`) sit on top.

## Technical Context

- **Language / runtime**: TypeScript on Bun (`Bun.spawn`, `Bun.YAML` in tests)
- **Storage**: SQLite table `session_prs`, created lazily by `src/ci/pr.ts`
- **External tools**: `gh` (signed in as the operator), `git` (push, diff stat) through `src/git/worktree.ts`
- **Testing**: `bun test tests/ci.test.ts`, with `setGhRunner` replacing `gh` and a local bare remote for the push

## Hooks into shared code

- `daemon/server.ts`: register `ciRoutes` (not edited here; see the report).
- `cli/main.ts`: `cmdPr` and `cmdCi` (not edited here).
- Web: `PrPanel` and `OpenPrButton` are mounted by the owner of the session header and the workspace view (not edited here).
- Reads only: `sessions/manager.ts` (`getSession`), `sessions/finalize.ts` (`parseShortstat`), `workspaces.ts` (`owningWorkspace`, `resolveRoot`).

## Decisions

- The workflow never runs a command that is not in `detectVerifyCommands`' vocabulary, and every `run:` is a block scalar.
- A project with nothing to verify gets an error, not a workflow.
- Merging refuses failing checks in TreeBoss, even when the repo would allow it. Pending checks are left to gh and the repo's rules.
- `waitForChecks` treats "none" as still pending until the timeout, because checks appear a moment after a push.
- The table key is (workspace, number), since a PR number is unique within a repository.
