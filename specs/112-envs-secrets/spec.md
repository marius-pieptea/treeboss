# Feature Specification: Environments and encrypted secrets

**Feature**: `112-envs-secrets`
**Status**: Implemented
**Input**: Each workspace has environments (dev, staging, prod, or custom) and secrets per environment. Values are encrypted on the machine and never returned by any endpoint. Dev servers of a workspace get its dev secrets. The CLI and the web UI manage them; `.env` files can be imported and exported on explicit request.

## User Scenarios & Testing

### User Story 1 - Keep a workspace's secrets out of the repo (Priority: P1)

I set `DATABASE_URL` for the dev environment of a workspace once, and the dev server started from TreeBoss gets it. I never write it into a file in the repo.

**Why this priority**: it is the reason the feature exists: dev servers need credentials and the factory's later slices (deploy, mobile, signals) need the same store.

**Independent Test**: `trb secret set DATABASE_URL` in a project, then start its dev task: the child process sees `DATABASE_URL`; `trb secret ls` shows the name and the time, never the value.

**Acceptance Scenarios**:

1. **Given** a dev secret `FROM_STORE` in a workspace, **When** a dev task of that workspace starts, **Then** its environment contains `FROM_STORE`.
2. **Given** the same name set in the daemon's own environment, **When** a dev task starts, **Then** the daemon's value wins.
3. **Given** a secret named `TRB_TOKEN`, **When** a dev task starts, **Then** it is not handed to the child.
4. **Given** a staging secret, **When** a dev task starts, **Then** it is not in the child's environment.

### User Story 2 - Set and replace values without seeing them again (Priority: P1)

In the web UI, the Secrets panel lists each key with a masked value, and I can set a new one, replace one, or delete one. In the CLI, `trb secret set KEY` reads the value from stdin when it is not given as an argument, so it stays out of shell history.

**Independent Test**: set a value in the panel; reload; the key shows as set with a masked value and no way to read the old value.

**Acceptance Scenarios**:

1. **Given** a key in dev, **When** I replace it, **Then** the list shows the new update time and the value is never displayed.
2. **Given** a key, **When** I delete it after confirming, **Then** it is removed from that environment only.

### User Story 3 - Work with environments (Priority: P2)

I see dev, staging and prod as tabs. I can add a custom environment such as `qa` with an optional URL, and remove it (with its secrets). The three built-in environments cannot be removed.

### User Story 4 - Move values in and out of .env files on request (Priority: P2)

`trb secret import .env.staging --env staging` loads a file inside the project. `trb secret export --env dev` writes `.env.dev` with mode 0600, and only when I run it. An existing file is replaced only with `--force`.

**Acceptance Scenarios**:

1. **Given** a file outside the project folder, **When** I import it, **Then** the request is refused.
2. **Given** `.env.dev` already exists, **When** I export without `--force`, **Then** nothing is written and the message says so.

### Edge Cases

- A value copied onto another row, or with another name, does not decrypt (the workspace, environment and name are bound into the ciphertext).
- A missing or replaced master key makes stored secrets unreadable: the error says so and never shows a value.
- A value over 64 KB, a key name that is not an environment variable name, and a URL that is not http(s) are refused.
- A dotenv line that is not an assignment is skipped and counted; a later assignment of the same key wins.
- Several workspaces never see each other's secrets.

## Requirements

### Functional Requirements

- **FR-001**: Secret values MUST be encrypted at rest with AES-256-GCM under a master key kept in the TRB home (`secrets.key`, created with 0600 on first use).
- **FR-002**: No HTTP response, CLI output or log MUST contain a secret value. Listings carry names and times.
- **FR-003**: Environments MUST be stored per workspace. dev, staging and prod MUST always be listed; custom ones exist once added; the built-in three MUST NOT be removable.
- **FR-004**: `resolveEnv(workspaceId, env)` MUST return the decrypted secrets of one environment for server-side callers only.
- **FR-005**: A dev service MUST receive the workspace's `dev` secrets under the daemon's environment (the process env wins), with `TRB_TOKEN` stripped.
- **FR-006**: `.env` import and export MUST only touch files inside the workspace folder. Export MUST write with mode 0600, MUST NOT overwrite without `force`, and MUST run only on an explicit request.
- **FR-007**: The web panel MUST use design tokens only, and MUST NOT display a value.

### Key Entities

- **Environment**: workspace, name, optional URL.
- **Secret**: workspace, environment, name, encrypted value, update time.

## Success Criteria

- **SC-001**: `bun test tests/secrets.test.ts` passes; the spawn test runs where the run manager's `/bin/sh` exists.
- **SC-002**: A search of every route response and CLI output for a planted value finds nothing.
- **SC-003**: `bun run typecheck` passes.

## Assumptions

- Secrets are per workspace, not per session. A session's isolated worktree lies outside the workspace folder, so the devserver route names the workspace from the session's base folder and passes its id (`StartInput.workspaceId` in `src/devserver/manager.ts`), and the worktree gets the injection.
- The master key lives beside the database in the TRB home. Losing it loses the secrets; backing up the home backs up the key.
- Windows ignores POSIX file modes; the key and exports rely on the user profile's ACL there.
