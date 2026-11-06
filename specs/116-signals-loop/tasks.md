# Tasks: Signals loop

- [x] T001 Shared types and source error (`src/signals/types.ts`)
- [x] T002 Signal store with lazy tables and per-workspace feedback tokens (`src/signals/store.ts`)
- [x] T003 Sentry source: config, issue fetch, severity mapping, upsert (`src/signals/sources/sentry.ts`)
- [x] T004 PostHog source: config, HogQL queries, metric upsert (`src/signals/sources/posthog.ts`)
- [x] T005 `syncSignals` with per-source isolation and injectable env and fetch (`src/signals/sync.ts`)
- [x] T006 Feedback intake rules, rate limiter and widget snippet (`src/signals/feedback.ts`)
- [x] T007 Triage: to_finding, to_roadmap, to_session, ignore; auto-triage prompt (`src/signals/triage.ts`)
- [x] T008 Routes and public intake handler (`src/daemon/routes/signals.ts`)
- [x] T009 CLI `trb signals` (`src/cli/commands/signals.ts`)
- [x] T010 Web data hooks and inbox (`web/src/features/signals/`)
- [x] T011 Tests for store, sources, sync, intake, triage and routes (`tests/signals.test.ts`)
- [x] T012 Register the routes in `server.ts` (module list, and the public-path line before authentication)
- [x] T013 Register the CLI in `main.ts` (import, switch case, usage line)
- [x] T014 Mount the inbox in the shell
- [x] T015 Wire `envProvider` to `resolveEnv(workspaceId, "prod")` in the routes and in the scheduler
- [x] T016 Scheduler calls `syncSignals` on a timer (the `signals_sync` schedule kind in src/autopilot/schedule.ts)
