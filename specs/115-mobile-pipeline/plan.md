# Plan: Mobile pipeline (Expo and EAS)

- `src/mobile/detect.ts` Expo detection from package.json, app.json, app.config.*, eas.json (pure reads, no execution of config).
- `src/mobile/eas.ts` argv builders, `runEas` with an injectable `Runner` and `EnvProvider`, JSON parsing for builds, `startBuild`, `listBuilds`, `viewBuild`, `submitLatest`, `publishUpdate`. Input checks run before argv is built.
- `src/mobile/store.ts` tables `mobile_builds` and `mobile_submissions` (created on first use), build and submission records, `refreshInFlightBuilds` (build:view), `startMobilePoller`, `checkStoreMetadata` and `readStoreMetadata`.
- `src/mobile/preview.ts` `expoGoUrl` (one `expo start --tunnel` process per directory, exp:// URL, QR SVG via `src/remote/qr.ts`), `stopExpoPreview`, `stopAllExpoPreviews`.
- `src/verify/detect.ts` Expo checks: `tsc --noEmit` when no typecheck script, `doctor` (`npx expo-doctor`) only when `expo-doctor` is declared, ordered last.
- `src/daemon/routes/mobile.ts` `GET /api/mobile/:root`, `GET|POST /api/mobile/:root/builds`, `POST /api/mobile/:root/submit`, `POST /api/mobile/:root/update`, `GET /api/mobile/:root/preview`.
- `src/cli/commands/mobile.ts` `trb mobile [show|metadata|build|builds|submit|update|preview]`.
- Web: `web/src/features/mobile` (`MobilePanel`, `data.ts`): builds per platform with status words, build and submit buttons, an OTA update form, store-listing issues, and the preview QR.

Wiring that lives outside this slice (the daemon and shell files are not owned here): the route module is registered in `src/daemon/server.ts`, the CLI in the command dispatch in `src/cli/main.ts`, the panel in the shell's tab registry, `setEnvProvider` is set from the secrets slice at daemon start, and `startMobilePoller` starts with the daemon.

Decisions:
- The preview owns its tunnel process. The devserver manager runs package.json scripts only and cannot pass `--tunnel`.
- `expo-doctor` is gated on the project's declaration because it reaches the network and a failure would send the agent into an automatic fix loop.
- EAS environment: the child gets the daemon's environment with the workspace's values on top, plus `CI=1` so no prompt can hang a call.
