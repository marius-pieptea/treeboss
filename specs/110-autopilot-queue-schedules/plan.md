# Implementation Plan: Unattended execution (autopilot and scheduled jobs)

**Feature**: `110-autopilot-queue-schedules`
**Spec**: [spec.md](spec.md)

## Approach

Two modules that own their tables and are created lazily, as `src/roadmap/store.ts` does. Neither touches `src/db.ts`.

- `src/autopilot/runner.ts` is the loop. It is a synchronous pass (`advanceAll`) over the runs that are working. Each pass settles what is in flight (session state plus the verify state in `session_verify`), ticks what passed, applies gates, and starts the next task or batch through the existing entry points (`runTask` in `specs/implement.ts`, `createLead` for isolated batch members). It is driven by the session hub (`turn_end`, `state`) and a 30s fallback timer. A re-entrancy flag makes a nested call mark the pass dirty rather than read half-written state.
- `src/autopilot/schedule.ts` owns the `schedules` table and a 60s ticker. It starts jobs through `createLead` (prompt and deps_update), `startSweep` (lab_sweep) and `runAll` (verify, run in the workspace, result kept on the job).
- `src/autopilot/cron.ts` is a pure five-field cron parser, with no dependency.

## Decisions

- **Verify is the gate for ticking.** A task is ticked only when its session's verify state is `passed`. `off`, `none` or no verify row at all stops the run with a message, rather than ticking unchecked work.
- **Verify retries are verify's own.** Autopilot does not re-run a failed task. It reads the verify state after its automatic fixes (`max_retries`) and stops when they are used up.
- **Restart.** `recoverOnStartup` marks interrupted sessions `failed` with a `last_error` starting `interrupted`. The loop sends such a session a follow-up instead of starting its task again.
- **Pull requests are opt-in.** A run started with `open_pr` opens a PR for each passed task (`sessionToPr`) and polls its checks (`watchChecks` in `src/autopilot/runner.ts`) through the CI slice's `waitForChecks`. The task is ticked once the checks pass. Without the flag nothing changes.
- **Budget is between tasks.** A task in flight is settled before the budget stops the run, so its box is not lost. The overshoot is bounded by the tasks in flight.
- **Parallel merge.** Batch members run isolated. Once the batch has passed, each member's commits are applied to the workspace with `mergePatch` (the function behind subagent merges). `tasks.md` is not edited by members, so their patches do not conflict on the checkboxes; the runner ticks the boxes after the merge.
- **`[APPROVE]`** is read from the task text (the parser keeps it in `text`). `tasks.md` parsing is not changed.
- **Gate keys.** Each gate has a key (`every:<n>`, `tag:<line>`, `merge:<lines>`). Approving records the key in `cleared`, so the same gate does not fire again.
- **Routes and CLI** follow `routes/roadmap.ts` and `commands/roadmap.ts`. Errors are `UserError` (400) and `RootError` (its status), as the server maps them.

## Data

- `autopilot_runs`: the columns in the brief, plus `concurrency`, `current_task`, `reason`, and `state` (JSON: done, active members, gate, sessions, cleared). `log` is JSON, trimmed to the last 300 entries.
- `schedules`: the columns in the brief. `next_run_at` is epoch milliseconds. `last_result` (JSON) holds the outcome of a lab sweep or a verify job.

## Files

- `src/autopilot/cron.ts`, `src/autopilot/runner.ts`, `src/autopilot/schedule.ts`
- `src/daemon/routes/autopilot.ts` (both prefixes, one module)
- `src/cli/commands/autopilot.ts` (`cmdAutopilot`, `cmdSchedule`)
- `web/src/features/autopilot/` (`data.ts`, `logic.ts`, `AutopilotPanel.tsx`, `SchedulesEditor.tsx`)
- `tests/autopilot-cron.test.ts`, `tests/autopilot-runner.test.ts`, `tests/autopilot-schedule.test.ts`, `tests/autopilot-routes.test.ts`

## Wiring (not done here: shared registries)

See [tasks.md](tasks.md), the last phase, for the exact lines.

## Risks

- A verify row that is never written (verify off in a path that skips it) leaves a member waiting. The loop waits on a null verify state, so a stuck member stops the run only when verify writes a state. The 30s fallback re-checks but cannot time it out.
- Parallel batches hold worktrees until the batch ends. A stop interrupts the unfinished members, but their worktrees are cleaned up by the usual session close, not by the run.
