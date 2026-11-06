# Plan: Environments and encrypted secrets

- `src/secrets/crypto.ts` AES-256-GCM seal and open under a master key at `<home>/secrets.key` (32 bytes, 0600, created on first use). The workspace, environment and name are bound in as associated data.
- `src/secrets/dotenv.ts` `.env` text parse and format (pure).
- `src/secrets/store.ts` tables `environments` and `secrets` (created lazily, like the roadmap store): `listEnvs`, `addEnv`, `removeEnv`, `setSecret`, `unsetSecret`, `listSecretKeys` (names only), `resolveEnv` (decrypted, server side only), `importDotenv`, `exportDotenv`. Paths are confined to the workspace folder.
- `src/devserver/manager.ts` `devSecrets(rootDir, workspaceId)` reads `resolveEnv(workspace, "dev")` for the workspace id the route passes, else through `owningWorkspace`. The route (`src/daemon/routes/x_devserver.ts`) takes it from a session's base folder; `childEnv` merges it under the process env and strips `TRB_TOKEN`. `childEnv` is exported for tests.
- `src/daemon/routes/secrets.ts` `/api/workspaces/:id/envs` and `/api/workspaces/:id/secrets`, including import and export.
- `src/cli/commands/secrets.ts` `trb secret` and `trb env`.
- Web: `features/secrets` (`data.ts` hooks, `SecretsPanel.tsx` with env tabs and the masked key list).
- Tests: `tests/secrets.test.ts` (cipher, store, dotenv, injection, routes).

Not in this slice: the registration lines for the server, the CLI index and the web shell, and the README and ROADMAP entries. They are listed in the report.
