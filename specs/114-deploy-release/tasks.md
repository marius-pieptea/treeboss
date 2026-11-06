# Tasks: Deploy targets, deploy history, rollback, domains and releases

**Feature**: `114-deploy-release` | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

Format: `- [ ] T001 [P] [US1] Description with exact file path`.

## Phase 1: Providers

- [x] T001 Provider contract and argv runner (no shell), redaction, URL extraction, status probe in src/deploy/providers/types.ts and src/deploy/providers/exec.ts
- [x] T002 [US1] Cloudflare: Workers or Pages from the wrangler config, rollback for Workers, Pages reports no rollback, in src/deploy/providers/cloudflare.ts
- [x] T003 [US1] Vercel: deploy with --prod for prod, token as VERCEL_TOKEN, rollback to the deployment URL, in src/deploy/providers/vercel.ts
- [x] T004 [US1] Fly: flyctl deploy, release version from flyctl releases --json, flyctl releases rollback, in src/deploy/providers/fly.ts
- [x] T005 [US1] Command provider: config.argv, optional rollbackArgv with {id}, in src/deploy/providers/command.ts
- [x] T006 Registry and detection in src/deploy/providers/index.ts

## Phase 2: Store, jobs and rollback

- [x] T007 [US1] Targets: create, update, delete, validation (env slug, https URL, argv shape) in src/deploy/store.ts
- [x] T008 [US1] runDeploy as a background job, streaming redacted log tail, one job per target, startup sweep of interrupted rows in src/deploy/store.ts
- [x] T009 [US2] rollbackDeploy: live deploy only, previous artifact, recorded as a rollback row in src/deploy/store.ts
- [x] T010 Legacy `deploys` table from spec 030: detect and use deploy_runs instead, in src/deploy/store.ts

## Phase 3: Domains and releases

- [x] T011 [US3] Cloudflare DNS: zones, zone for a name, upsert CNAME, propagation over DoH, addDomain with the env token, in src/deploy/domains.ts
- [x] T012 [US4] Versions, conventional commits, changelog sections in src/deploy/release.ts
- [x] T013 [US4] planRelease (read only) and cutRelease (refuses dirty tree and existing tag, restores on failure, commit and tag) in src/deploy/release.ts

## Phase 4: HTTP, CLI, web

- [x] T014 Routes for targets, runs, history, rollback, domains, release, providers in src/daemon/routes/deploy.ts
- [x] T015 CLI: trb deploy [env]|targets|history|rollback, trb release plan|cut, trb domain add|check in src/cli/commands/deploy.ts
- [x] T016 [US1] Pipeline view with dev, staging and prod cards, deploy, roll back and history in web/src/features/deploy/DeployView.tsx, web/src/features/deploy/PipelineCard.tsx
- [x] T017 [US4] Release dialog: bump preview, changelog, cut with confirmation in web/src/features/deploy/ReleaseDialog.tsx
- [x] T018 Pure pipeline rules and react-query hooks in web/src/features/deploy/logic.ts, web/src/features/deploy/data.ts

## Phase 5: Tests and spec

- [x] T019 Tests: changelog and version rules, detection, validation, background runs with redaction and env delivery, failure paths, rollback rules, legacy table, domains with a fake fetch, releases in a temp git repo, routes, pipeline rules in tests/deploy.test.ts
- [x] T020 Spec, plan and tasks in specs/114-deploy-release/

## Phase 6: Parent wiring (not done in this slice)

- [x] T021 Register deployRoutes in src/daemon/server.ts (modules array)
- [x] T022 Register cmdDeploy, cmdRelease and cmdDomain in src/cli/main.ts (import, switch, help text)
- [x] T023 Plug resolveEnv from src/secrets into setEnvProvider at daemon start (src/deploy/store.ts)
- [x] T024 Mount DeployView in a shell view under web/src/shell/ (mounted instead on the Ship page of the factory tab, web/src/features/factory/FactoryView.tsx, opened by the "Factory: ship" command in web/src/shell/commands.tsx)
- [x] T026 Document the feature in ROADMAP.md and README.md (not edited in this slice)

## Live checks

These need an account, a CLI or the network this machine does not have. They are not tasks, so the specs view does not count them.

- T025 Check the fly rollback form against a real flyctl, and the wrangler rollback flag against the installed wrangler. Needs `flyctl` and `wrangler` installed and signed in.
