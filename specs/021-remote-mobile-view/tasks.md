# Tasks: Mobile / Remote View

**Feature**: `021-remote-mobile-view` | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

Format: `- [ ] T001 [P] [US1] Description with exact file path`.

## Phase 1: Auth core

- [x] T001 [US1] Token store, pair codes, rate limiter in src/remote/
- [x] T002 [US1] Route policy (default deny) in src/remote/policy.ts
- [x] T003 [US1] Host/peer rules and bind host in src/remote/hosts.ts
- [x] T004 [US1] Server integration: principal, policy check, WebSocket gating in src/daemon/server.ts, src/daemon/live.ts
- [x] T005 [US3] Owner-only management routes in src/daemon/routes/remote.ts
- [x] T006 Settings: remote_* keys in src/settings.ts

## Phase 2: Surfaces

- [x] T007 [US1] `trb remote` (status, pair with terminal QR, ls, revoke) in src/cli/commands/remote.ts
- [x] T008 [US2] Compact remote UI in web/src/remote/
- [x] T009 [US1] [US3] Settings page: switches, pair dialog, device list in web/src/features/settings/RemotePage.tsx

## Phase 3: Tests and docs

- [x] T010 Auth boundary tests (off by default, one-time, expiry, rate limit, deny list, revoke, sockets, host rules)
- [x] T011 docs/REMOTE.md; README pointer (tunnel setup removed in spec 030)
