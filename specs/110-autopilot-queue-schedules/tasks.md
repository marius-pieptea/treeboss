# Tasks: Unattended execution (autopilot and scheduled jobs)

**Input**: [spec.md](spec.md), [plan.md](plan.md)

## Phase 1: Setup

- [x] T001 Read the conventions: roadmap store, routes, CLI and feature; the verify loop; the lab sweep driver; the parks timer
- [x] T002 [P] Cron parser with no dependency in src/autopilot/cron.ts

## Phase 2: Autopilot runs (User Story 1, 2, 3, 4, 7)

- [x] T003 [US1] Runs table `autopilot_runs` created lazily, with the loop state in JSON, in src/autopilot/runner.ts
- [x] T004 [US1] Start a run: validate the spec, refuse a second open run on it, set budget, task limit, concurrency and gates in src/autopilot/runner.ts
- [x] T005 [US1] One pass per run: settle in-flight tasks against the session and verify state, tick the box once verify passes, start the next task via runTask in src/autopilot/runner.ts
- [x] T006 [US2] Budget (sum of the turns' cost), checked between tasks, and the task limit in src/autopilot/runner.ts
- [x] T007 [US3] Approval gates: every N tasks, [APPROVE] tasks, merge of a parallel batch; approve and reject in src/autopilot/runner.ts
- [x] T008 [US4] Pause, resume and stop in src/autopilot/runner.ts
- [x] T009 [US7] Restart: sessions interrupted by a restart get a follow-up instead of a new start; the loop is driven by the hub and a 30s fallback in src/autopilot/runner.ts
- [x] T010 [US1] Tests for the sequential loop, budget, task limit, gates, reject, verify failure, pause in tests/autopilot-runner.test.ts

## Phase 3: Parallel batches (User Story 5)

- [x] T011 [US5] Start [P] tasks together in isolated worktrees up to the concurrency, then merge with mergePatch once all pass in src/autopilot/runner.ts
- [x] T012 [US5] Test: two [P] tasks start together and both are ticked in tests/autopilot-runner.test.ts
- [x] T013 [US5] Test a merge conflict: the run stops, the branch is kept, no box of the batch is ticked (tests/autopilot-runner.test.ts)

## Phase 4: Scheduled jobs (User Story 6)

- [x] T014 [US6] Schedules table `schedules`, CRUD with validation, next slot kept when unchanged in src/autopilot/schedule.ts
- [x] T015 [US6] Ticker: due jobs start once per slot, a missed slot runs once, a disabled job does not run in src/autopilot/schedule.ts
- [x] T016 [US6] Kinds: prompt, deps_update (built-in prompt), lab_sweep (startSweep), verify (runAll, result kept on the job) in src/autopilot/schedule.ts
- [x] T017 [US6] Tests in tests/autopilot-schedule.test.ts and tests/autopilot-cron.test.ts

## Phase 5: Routes and CLI

- [x] T018 Routes under /api/autopilot and /api/schedules in src/daemon/routes/autopilot.ts
- [x] T019 Route tests (through the module's handler, not a running server) in tests/autopilot-routes.test.ts
- [x] T020 CLI `trb autopilot` and `trb schedule` in src/cli/commands/autopilot.ts
- [x] T021 CLI smoke test against a running daemon (tests/autopilot-cli.test.ts)

## Phase 6: Web

- [x] T022 Data hooks, polling while runs work, in web/src/features/autopilot/data.ts
- [x] T023 Runs list with live status, run detail with log and controls, approval banner in web/src/features/autopilot/AutopilotPanel.tsx
- [x] T024 Schedules editor in web/src/features/autopilot/SchedulesEditor.tsx
- [x] T025 Visual check in the running app (light and dark, the banner, the editor; browsed in Edge, it led to visible checkbox labels and Approve and Reject buttons in the run detail, web/src/features/autopilot/AutopilotPanel.tsx)

## Phase 7: Wiring (shared registries, done by the parent)

- [x] T026 src/daemon/server.ts: `import { autopilotRoutes } from "./routes/autopilot";` and add `autopilotRoutes` to `modules`, after `roadmapRoutes`
- [x] T027 src/daemon/lifecycle.ts: `import { startAutopilot, stopAutopilot } from "../autopilot/runner";` and `import { startScheduler, stopScheduler } from "../autopilot/schedule";`; call `startAutopilot(); startScheduler();` after `startSweepDriver();` (after `recoverOnStartup()`), and `stopAutopilot(); stopScheduler();` in `shutdown` next to `stopSweepDriver()`
- [x] T028 src/cli/main.ts: `import { cmdAutopilot, cmdSchedule } from "./commands/autopilot";`, cases `autopilot` → `cmdAutopilot(rest)` and `schedule` → `cmdSchedule(rest)`, and a usage line for each
- [x] T029 Web: mount `<AutopilotPanel workspaceId={…} />` and `<SchedulesEditor workspaceId={…} />` in a workspace surface (not done here: the shell is a shared registry)

## Phase 8: Polish

- [x] T030 Restart test: a run with an interrupted task resumes after the daemon restarts (tests/autopilot-runner.test.ts)
- [x] T031 Typecheck (`bun run typecheck`) and the autopilot tests pass
