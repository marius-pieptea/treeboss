# Feature Specification: CI workflow and pull requests from sessions

**Feature**: `113-ci-pr-flow`
**Status**: Implemented
**Input**: A workspace gets a `.github/workflows/ci.yml` generated from what its project has. A session that ran in its own worktree branch becomes a pull request with one action, and the operator can see its checks and merge it from TreeBoss. Everything goes through the operator's own `gh` login.

## User Scenarios & Testing

### User Story 1 - A CI workflow that matches the project (Priority: P1)

I run `trb ci init` in a project. It shows the workflow it would write: the package manager's install, the typecheck, lint and test commands TreeBoss already detects, and a Playwright job when a Playwright config exists. `trb ci init --write` writes it.

**Why this priority**: a PR is only worth opening if the project checks it. The commands must be the ones the project already runs locally.

**Independent Test**: `planWorkflow` on a fixture with `bun.lock`, a `typecheck` and `test` script and a `playwright.config.ts` returns YAML whose verify job runs `bun install --frozen-lockfile`, `bun run typecheck` and `bun run test`, and whose e2e job runs `bunx playwright test`.

**Acceptance Scenarios**:

1. **Given** a bun project with a lockfile, **When** I plan the workflow, **Then** the install is frozen to the lockfile, the dependency cache is keyed on it, and each detected command is a step.
2. **Given** an npm, pnpm or yarn project, **When** I plan it, **Then** the install and cache use that manager.
3. **Given** a folder with no verify command and no Playwright config, **When** I plan it, **Then** nothing is planned and the reason is given, rather than a CI that runs nothing and shows green.
4. **Given** a `.github/workflows/ci.yml` already exists, **When** I write without `--overwrite`, **Then** the file is kept and the command says so.

### User Story 2 - Turn a session into a PR (Priority: P1)

A session that worked in its own worktree branch has an "Open PR" button. I press it. The branch is pushed, and a PR opens with the session's title, its latest turn's output as the summary, and a diff stat.

**Why this priority**: this is the step where agent work leaves the daemon for review.

**Independent Test**: with a bare remote and a session whose worktree has one commit, `sessionToPr` pushes the branch, calls `gh pr create` with the session title and a body that contains the turn output and `1 file changed, +1 -0`, and records the PR in `session_prs`.

**Acceptance Scenarios**:

1. **Given** a session with an open PR, **When** I press Open PR again, **Then** the existing PR is returned and no second PR is opened.
2. **Given** a session that runs without a worktree, **When** I press Open PR, **Then** I am told it has no branch of its own.
3. **Given** `gh` is not installed or not signed in, **When** I press Open PR, **Then** the message names the fix (install `gh`, or `gh auth login`).

### User Story 3 - Checks and merge from TreeBoss (Priority: P2)

The PR panel lists the open PRs of a workspace. Each shows its checks as a labelled pill (passing, running, failing, no checks) and a merge button. Merging asks first, and is refused while checks are failing.

**Independent Test**: `prMerge` on a PR whose checks roll up to failing makes no merge call and returns 409.

**Acceptance Scenarios**:

1. **Given** a PR with failing checks, **When** I look at the panel, **Then** the merge button is disabled and the pill says "checks failing".
2. **Given** a PR with passing checks, **When** I merge it and confirm, **Then** it is squash-merged (or the method I chose) and the list refreshes.
3. **Given** the autopilot waits on a PR, **When** it calls `waitForChecks`, **Then** it gets the settled state, or a timeout.

### Edge Cases

- A check run gh reports without a bucket is grouped from its state.
- `gh pr checks` exits non-zero while checks are pending or failing; its JSON is still read.
- A PR opened outside TreeBoss appears in the list with no session.
- A repo without an `origin` remote: the push fails and the message says so.
- A workspace with `.github` as a symlink out of the folder: the write is refused.

## Requirements

### Functional Requirements

- **FR-001**: The workflow MUST be generated from the files of the workspace (lockfile, manifests, Playwright config). Every `run:` line MUST be one of the detected commands.
- **FR-002**: `writeWorkflow` MUST NOT replace an existing workflow unless `overwrite` is set.
- **FR-003**: Every `gh` call MUST be an argument array run without a shell, with prompts disabled. The PR body MUST be passed on stdin.
- **FR-004**: A missing or signed-out `gh` MUST return a 412 with the fix in the message.
- **FR-005**: `sessionToPr` MUST push only the session's own branch, and MUST return the open PR when the session already has one.
- **FR-006**: `session_prs` MUST hold (workspace, number, session, url, state, checks state, updated time). It is created lazily, like the roadmap tables. `src/db.ts` is not changed.
- **FR-007**: `prMerge` MUST refuse a PR that is not open, and one whose checks are failing.
- **FR-008**: The web panel MUST use design tokens only and show the checks state with a word, not color alone.

### Key Entities

- **Workflow plan**: the path, whether it exists, the YAML, and the detected inputs.
- **PR**: number, title, URL, state (open, closed, merged), draft, head and base branch, and its session if TreeBoss opened it.
- **Checks state**: none, pending, passing or failing, rolled up from the check runs.

## Success Criteria

- **SC-001**: `bun test tests/ci.test.ts` passes without a `gh` installed on the machine (gh is replaced by a scripted runner).
- **SC-002**: From a session with a worktree branch, one action yields a PR on GitHub whose body names the change.
- **SC-003**: No `gh` or `git` call goes through a shell.

## Assumptions

- The operator has `gh` installed and signed in. TreeBoss does not store a GitHub token.
- The default branch is `main` in generated triggers. Repos with another default branch edit the `push` filter.
- A workspace is one repository. Monorepo sub-folders are not detected separately.
- Autopilot calls `waitForChecks` only when a run is started with `open_pr` (`trb autopilot start --open-pr`). It is opt-in. Such a run opens a PR for each passed task and waits for its checks (`watchChecks` in `src/autopilot/runner.ts`).
