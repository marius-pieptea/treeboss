# Tasks: Remote access modes, and removing the Cloudflare deploy

**Feature**: `030-remote-modes-and-remove-cloudflare` | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

Format: `- [ ] T001 [P] [US1] Description with exact file path`.

## Phase 1: Remove Cloudflare

- [x] T001 Delete src/deploy, src/daemon/routes/deploy.ts, src/cli/commands/deploy.ts, web/src/features/deploy, docs/DEPLOY.md, specs/022, tests/deploy*.test.ts
- [x] T002 Remove the `trb deploy` case and help, the Settings Deploy page/sidebar item/palette command, the stale-deploy lifecycle hook, deploy 403 test rows, README section

## Phase 2: Modes

- [x] T003 [US1] [US2] Detection: LAN pick and Tailscale CLI in src/remote/network.ts
- [x] T004 [US3] Second listener lifecycle in src/remote/listener.ts; `remoteServe`, reconcile and loopback-Host refusal in src/daemon/server.ts
- [x] T005 [US1] [US2] `remote_mode` setting, validation, change hook in src/settings.ts; mode, Host rules and migration in src/remote/hosts.ts
- [x] T006 [US4] Migration of remote_access / remote_bind / remote_hosts
- [x] T007 [US1] [US2] Status and pair routes build links from the mode; never loopback in src/daemon/routes/remote.ts
- [x] T008 `trb remote status`, `trb remote pair --local` in src/cli/commands/remote.ts

## Phase 3: UI, tests, docs

- [x] T009 Settings > Remote access: mode selector, status, QR + text link, devices, grants in web/src/features/settings/RemotePage.tsx; helpers in web/src/remote/logic.ts
- [x] T010 Tests: host rules per mode, listener addresses, mode switch closes sockets, migration, no-localhost link, availability refusals in tests/remote-auth.test.ts, tests/remote-cli.test.ts, tests/web/remote.test.ts
- [x] T011 Rewrite docs/REMOTE.md for LAN and Tailscale; README pointer
- [x] T012 scripts/ui-remote.ts on the new flow, run in headless Chrome
