# Tasks: Run-the-app panel and live preview element picking

## Phase 1: Daemon (run)

- [x] T001 [US1] Detection in src/devserver/detect.ts (+ tests/devserver-detect.test.ts)
- [x] T002 [US2] Free port and port flag rules in src/devserver/ports.ts
- [x] T003 [US1] Process manager with logs in src/devserver/manager.ts (+ tests/devserver-manager.test.ts)
- [x] T004 [US1] [US5] HTTP routes in src/daemon/routes/x_devserver.ts, registered in src/daemon/server.ts

## Phase 2: Daemon (preview)

- [x] T005 [US3] Inspector script and proxy in src/preview/ (+ tests/preview-proxy.test.ts)
- [x] T006 [US4] Issues buffer and pick store; routes; MCP tools devserver_logs, preview_console
- [x] T007 [US3] Element screenshot in src/preview/shot.ts

## Phase 3: UI

- [x] T008 [US1] [US2] RunPanel in web/src/features/run/, wired into the Browser tab; preview auto-points at the running server
- [x] T009 [US3] [US4] Inspect toggle, Pick, Issues chip; composer-insert bus event
- [x] T010 Docs: README section

## Phase N: Polish

- [x] T099 bun test, typecheck, web build, try in the real UI
