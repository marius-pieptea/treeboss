# Feature Specification: Unattended execution (autopilot and scheduled jobs)

**Feature**: `110-autopilot-queue-schedules`
**Status**: Implemented
**Input**: An operator starts a run on a spec and walks away. The daemon works through the spec's open tasks one at a time, checks each one, ticks it, and stops for the operator at the gates they chose, or when it cannot go on. Separately, cron-style jobs run prompts, dependency updates, lab sweeps and the project's checks on a schedule.

## User Scenarios & Testing

### User Story 1 - Work through a spec without me (Priority: P1)

I start autopilot on a spec with open tasks. It takes the next open task, runs it in a session, waits for the turn and for the project's checks, requires them to pass, ticks the task in `tasks.md`, and moves on. I can see the run's status, the task it is on, what it has spent, and a log of what happened.

**Why this priority**: this is the point of the slice. Everything else is a stop, a gate or a reporting detail on top of it.

**Independent Test**: on a workspace with two open tasks and verification on, `trb autopilot start <spec>` ends with status `done`, both boxes ticked, and two sessions started.

**Acceptance Scenarios**:

1. **Given** a spec with open tasks T001 and T002, **When** I start a run, **Then** T001 starts, and once its checks pass its box is ticked and T002 starts, until no task is open and the run is `done`.
2. **Given** a spec with T000 already ticked, **When** I start a run, **Then** T000 is not started again.
3. **Given** a task whose checks still fail after verification's own fixes, **When** the run reaches it, **Then** the run is `failed`, the task's box stays open, and the reason names the task.

### User Story 2 - Stop before I lose money or the tree (Priority: P1)

A budget caps what the run may spend (the sum of the cost of its turns). A task limit caps how many tasks it finishes. When either is reached, nothing new starts; a task already in flight is settled first, so its paid-for turn is not thrown away.

**Acceptance Scenarios**:

1. **Given** a budget of $0.50 and a first task that costs $1.00, **When** that task settles, **Then** the run is `stopped` with "Budget reached", the first box is ticked, and the second task never starts.
2. **Given** a task limit of 2 and three open tasks, **When** two are done, **Then** the run is `stopped` and the third is not started.

### User Story 3 - Approve the gates I set (Priority: P1)

I choose where the run stops for me: after every N tasks, before a task tagged `[APPROVE]`, or before the changes of a parallel batch are merged into the workspace. The run shows an approval banner with the gate's text and Approve or Reject. Approve carries on; Reject stops the run before the gated work.

**Acceptance Scenarios**:

1. **Given** approval every 1 task, **When** the first task passes, **Then** the run is `awaiting_approval`, the banner shows "1 task(s) done", and nothing new has started.
2. **Given** a run waiting at a gate, **When** I reject it, **Then** the run is `stopped` with "Rejected: ..." and the gated task does not start.
3. **Given** a task tagged `[APPROVE]` and the tagged gate set, **When** the run reaches it, **Then** it waits; approving it starts the task.

### User Story 4 - Pause, resume, stop (Priority: P2)

I can pause a run (what is in flight finishes, nothing new starts), resume it, or stop it (what is in flight is interrupted).

**Acceptance Scenarios**:

1. **Given** a running run, **When** I pause it, **Then** the task in flight ticks when it passes, and the next task waits until I resume.

### User Story 5 - Parallel `[P]` tasks run together (Priority: P2)

A run of `[P]` tasks in one phase starts together, each in its own worktree, up to the run's concurrency. Each is checked in its own worktree. When the batch has passed, its changes are applied to the workspace (behind the merge gate if I chose one) and its boxes are ticked. A change that does not apply cleanly stops the run and keeps its branch.

**Acceptance Scenarios**:

1. **Given** two `[P]` tasks and concurrency 2, **When** I start a run, **Then** both sessions start at once, each isolated, and both boxes end up ticked.

### User Story 6 - Scheduled jobs (Priority: P2)

I create a job with a 5-field cron expression and a kind: `prompt` (a session with my prompt), `deps_update` (a session with a built-in dependency-update prompt), `lab_sweep` (a Lab sweep of one lens), or `verify` (the project's checks, whose result is kept on the job). The daemon starts due jobs each minute. I can run one now without moving its next slot.

**Acceptance Scenarios**:

1. **Given** a prompt job due at 02:00, **When** the ticker passes 02:00, **Then** one session starts with that prompt, and its next slot moves to the next day.
2. **Given** a job that missed its slot while the daemon was down, **When** the daemon is back, **Then** it runs once, not once per missed slot.
3. **Given** a disabled job, **When** its slot comes, **Then** nothing starts.

### User Story 7 - Survive a restart (Priority: P1)

A run that was working when the daemon stopped carries on when it is back. A task whose turn the restart interrupted is sent a follow-up that asks it to finish the task, not started again.

### Edge Cases

- A session for a task is closed by hand: the run fails with the task's id.
- Verification is off for the workspace: the run stops at the first task, saying that checks did not run. A task is never ticked without its checks passing.
- A cron expression with a name (`mon`), six fields, or a date that never comes is refused with the reason.
- Starting a second run on a spec that already has an open run is refused.

## Requirements

### Functional Requirements

- **FR-001**: A run MUST start only on a spec with at least one open task, and only one open run per spec and workspace.
- **FR-002**: The loop MUST tick a task's box only after that task's session has settled and verification has passed for it.
- **FR-003**: A run MUST stop with the reason when a verification fails after its retries, a turn fails, verification did not run, the budget is reached, or the task limit is reached.
- **FR-004**: The budget MUST be the sum of the cost of the run's sessions' turns. Nothing new starts once it is spent.
- **FR-005**: Approval gates MUST be `merge`, `tagged` and `every`, each optional. A cleared gate MUST NOT come back for the same point in the run.
- **FR-006**: Parallel `[P]` tasks MUST run isolated, and their changes MUST be applied to the workspace only once the whole batch has passed.
- **FR-007**: The loop state MUST live in the database. On boot, runs that were working MUST be picked up without an operator action.
- **FR-008**: The cron parser MUST accept five fields with `*`, numbers, ranges, lists and steps, and MUST refuse anything else with a reason. Day-of-month and day-of-week follow the standard either-matches rule.
- **FR-009**: The ticker MUST run each due job once per slot, and MUST NOT run a disabled job.
- **FR-010**: Routes MUST be under `/api/autopilot` and `/api/schedules`, and the CLI under `trb autopilot` and `trb schedule`.
- **FR-011**: A run MAY be started with `open_pr` (`trb autopilot start --open-pr`). It is off by default. With it, each task runs in its own session and worktree, a passed task opens a pull request, and the run waits for that pull request's checks before it ticks the task. Failing checks, or no verdict within an hour, stop the run with the box left open and the PR kept. No patch is applied to the workspace, because the change travels in the PR.

### Key Entities

- **Autopilot run**: a spec, a workspace, a status (running, paused, awaiting approval, done, failed, stopped), a budget and what it has spent, a task limit, a concurrency, approval gates, the tasks in flight, and a log.
- **Schedule**: a workspace, a name, a cron expression, a kind, a payload, an engine, enabled, and its last and next runs.

## Success Criteria

- **SC-001**: A two-task spec runs to `done` with no operator input, both boxes ticked.
- **SC-002**: No box is ever ticked for a task whose checks did not pass.
- **SC-003**: A budget stop never leaves a paid-for turn unsettled.
- **SC-004**: The cron parser refuses every malformed expression in its test set and computes the next slot correctly across weekdays, month ends and years.

## Assumptions

- Verification is on for the workspace. Autopilot does not turn it on, and refuses to tick tasks without it.
- Budgets are checked between tasks, so a run can exceed its budget by the cost of the tasks in flight when it is reached.
- Schedules run in the daemon's local time zone.
- Parallel tasks are merged by applying their patch (as `git apply`) to the workspace as uncommitted edits, the same way a subagent's work is merged.
- A task agent is told not to edit `tasks.md` when it runs in parallel: the runner ticks it.

## Out of scope

- Re-running a failed task automatically. A failed run stops, and the operator decides.
- Budgets in currency other than USD, and per-schedule budgets.
- Notifications when a run waits for approval (the banner and the CLI show it; a push is left for later).
