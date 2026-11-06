# Tasks: Mobile pipeline (Expo and EAS)

- [x] T001 Expo detection from package.json, app.json, app.config.*, eas.json, with tests
- [x] T002 EAS argv builders, input checks, JSON parsing and the runner, with tests
- [x] T003 Mobile builds and submissions tables, build:view poller, store listing check, with tests
- [x] T004 Expo Go tunnel preview with QR, with tests for the URL parser and the refusal
- [x] T005 Expo checks in verify detection (tsc, expo-doctor when declared), with tests
- [x] T006 HTTP routes with tests (route module, registered in src/daemon/server.ts)
- [x] T007 CLI `trb mobile` (registered in src/cli/main.ts)
- [x] T008 MobilePanel and data hooks in web/src/features/mobile (mounted on the Factory page, web/src/features/factory/FactoryView.tsx)
- [x] T009 Wire EXPO_TOKEN from the secrets slice through setEnvProvider
- [x] T010 Start the poller with the daemon and stop previews on shutdown

## Live checks

These need an account, a CLI or the network this machine does not have. They are not tasks, so the specs view does not count them.

- T011 Run a real build, submit and update against an EAS account. Needs an EAS account and an `EXPO_TOKEN`.
