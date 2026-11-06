# Feature Specification: Investigation runs

**Feature**: `106-investigation-runs`
**Status**: Implemented
**Input**: Creating or re-running an investigation starts an agent run that reverse-engineers the target with the browser or REA, persisted per run with live status

## User Scenarios & Testing

### User Story 1 - Create and run an investigation (Priority: P1)

I create an investigation in the Evidence tab: a title, a target (a URL, a local path or an app) and a kind, which defaults to auto (worked out from the target, see spec 107). The form defaults to **Create and run**. One press records the investigation and starts its run: an agent session that reverse-engineers the target and files what it finds under that investigation. I can still create one without running it. The run is a normal session, so I can open it and watch it.

**Why this priority**: an investigation used to sit empty until someone started the work by hand. This is the point of the change.

**Independent Test**: `POST /api/evidence/:root/investigations` with `run: true` returns the investigation and the started session; the session's prompt names the investigation it fills.

**Acceptance Scenarios**:

1. **Given** a web target and the agent browser is available, **When** I create and run, **Then** the investigation exists, a run starts, and its prompt tells the agent to navigate and capture pages with `evidence_capture_page`.
2. **Given** an Electron, binary, Android or other target and REA is available, **When** I create and run, **Then** the prompt tells the agent to use the REA tools (for example `inspect_electron_page`, `analyze_javascript_application`, `binary_overview`, `inspect_android_package`, `inspect_artifact`) and to save every useful result with `evidence_save_result`.
3. **Given** any run, **Then** the agent records features and UI designs with `evidence_finding`, conclusions with `evidence_note`, and ends with `investigation_close` and a summary.
4. **Given** any run, **Then** nothing is built in the project. A run reads and records; building stays the separate build hand-off.

### User Story 2 - Re-run and keep every run (Priority: P1)

An investigation keeps all its runs, not just the last one. **Run again** starts another run on the same investigation. Running again on a closed investigation reopens it. Past runs are listed under the investigation with their status, and each links to its session.

**Why this priority**: a second pass on a target is the normal case (the first run missed a page, or the target changed), and its history must not be lost.

**Independent Test**: run one investigation twice; both runs are listed, each with its own session, and the evidence from the first run is still there.

**Acceptance Scenarios**:

1. **Given** a closed investigation, **When** I press Run again, **Then** the investigation is reopened and a new run starts.
2. **Given** a finished run, **Then** its session stays openable and the evidence it filed stays on the investigation.

### User Story 3 - See run status live (Priority: P2)

Each investigation shows its run status: **running**, **finished**, **failed** or **not run**. While a run is going, the list refreshes every 3 seconds, so the status moves without a reload. **Open session** opens the session of the latest run.

**Why this priority**: runs take minutes, and an operator needs to know whether to wait, look, or re-run.

**Independent Test**: start a run and watch the list; its status goes from running to finished or failed without a manual refresh.

**Acceptance Scenarios**:

1. **Given** a run in progress, **Then** its investigation shows **running** and the list refreshes every 3 seconds until it ends.
2. **Given** an investigation that never ran, **Then** it shows **not run**.

### User Story 4 - Be told why a run did not start (Priority: P1)

If a run cannot start, I am told why, and nothing else is lost. An investigation created with a run is still created; the reason comes back with it.

**Why this priority**: a silent refusal looks like a bug. The operator must see the cause and the fix.

**Independent Test**: create and run a web investigation with the agent browser off; the investigation exists and the response carries the reason.

**Acceptance Scenarios**:

1. **Given** the agent browser is off and the target is a web URL, **When** I create and run, **Then** the investigation is created, no session starts, and the reason is shown.
2. **Given** a run is already in progress on an investigation, **When** I press Run again, **Then** no second session starts and the reason is shown.

### User Story 5 - Start runs from the CLI (Priority: P2)

`trb evidence run <inv>` starts a run on an existing investigation. `trb evidence investigate "<title>" --target … --kind … --run` creates one and starts its run.

**Why this priority**: the CLI is the same surface the operator uses for the other evidence commands.

**Independent Test**: `trb evidence investigate "x" --target https://example.com --kind web --run` prints the new investigation and its session; `trb evidence run <inv>` starts a second run on it.

### Edge Cases

- What happens when the evidence feature is off? The run is refused with that reason; the investigation is still created.
- What happens when the target is a local path that does not exist? The run is refused with that reason; the investigation is still created.
- What happens when a run is in progress and the daemon restarts? The run's status follows its session, and startup recovery fails that session, so the run reads **failed** (see Assumptions).

## Requirements

### Runs

- **FR-001**: Creating an investigation with `run: true` MUST record the investigation and then start one run on it. Without it, the investigation is only recorded.
- **FR-002**: A run MUST be one agent lead session. Each run MUST be a row in `investigation_runs` linked to its investigation and its session. An investigation MUST keep all its runs.
- **FR-003**: The run prompt MUST depend on the target kind. For `web` it MUST direct the agent browser to navigate and capture each page with `evidence_capture_page`. For `electron`, `binary`, `android` and `other` it MUST direct the agent to the REA tools and to save every useful result with `evidence_save_result`.
- **FR-004**: Every run prompt MUST direct the agent to record each feature and UI design with `evidence_finding`, each conclusion with `evidence_note`, and to finish with `investigation_close` and a summary.
- **FR-005**: A run MUST NOT build anything in the project: no edits to its code, its design system or its docs.
- **FR-006**: Running again MUST start another run on the same investigation. Running again on a closed investigation MUST reopen it.
- **FR-007**: An investigation with a run in progress MUST refuse a second run until the first one ends.

### Preflight

- **FR-008**: Before a session starts, the run MUST be checked, and refused with a stated reason when:
  - evidence is off for the project;
  - the target is `web` and the agent browser is not available;
  - the target is not `web` and REA is not available (REA is on, and Node with `npx` is present);
  - the target is a local path that does not exist;
  - the investigation already has a run in progress.
- **FR-009**: A refusal MUST NOT stop the investigation from being created. The reason MUST be shown to the operator in the UI and the CLI.

### Data

- **FR-010**: `investigation_runs` MUST hold one row per run, linked to its investigation and its session. A run's status MUST be the status of its session.
- **FR-011**: Each investigation's JSON MUST gain `runs[]` (each run with its session status) and `running` (true while a run is in progress).

### API

- **FR-012**: `POST /api/evidence/:root/investigations` MUST accept `run: true`. The response MUST carry the started session, or `runError` with the reason when the run was refused.
- **FR-013**: `POST /api/evidence/:root/investigations/:id/run` MUST start a run on an existing investigation, with the same refusals as the create route. A started run MUST answer 201 with the investigation and the session. A refused run MUST answer HTTP 400 with the reason as `error`, because the investigation already exists and there is nothing to keep beside it. An unknown investigation MUST answer 404.

### UI

- **FR-014**: The Evidence tab's create form MUST default to **Create and run**.
- **FR-015**: Each investigation MUST show its run status: running, finished, failed or not run. It MUST offer **Run** (or **Run again** when it has run before) and **Open session**, and list its past runs with their status and session links.
- **FR-016**: While any run is in progress, the investigation list MUST refresh every 3 seconds.

### CLI

- **FR-017**: `trb evidence run <inv> [-e engine] [-m model] [--note …] [-d]` MUST start a run on an existing investigation. `trb evidence investigate "<title>" [--target …] [--kind …] --run` MUST create one and start its run.

### Key Entities

- **Investigation run**: one agent session started on one investigation. Attributes: the investigation, the session, and the status read from that session. Several per investigation.

## Success Criteria

- **SC-001**: From the Evidence tab, one press on a web investigation with the agent browser available leads to a run that captures at least one page under that investigation.
- **SC-002**: Every refusal in FR-008 is shown with its reason, and none of them starts a session.
- **SC-003**: The investigation list shows a finished or failed run's status without a manual refresh.

## Out of Scope

- Saved logins per investigation.
- Attaching REA to the agent browser over CDP.
- API and network recording: proposed separately.

## Assumptions

- The create form keeps a way to create without running, beside **Create and run**. The brief names the default only.
- The create route keeps the investigation when its run is refused and answers 201 with `runError`. The run route has no such case, so a refusal there is a plain 400 with the reason.
- `-d` in `trb evidence run` prints the session id and returns, where without it the CLI follows the session (`src/cli/commands/evidence.ts`, the `follow` helper).
- `--note` is a focus line for the run. It is cut to 2,000 characters, shown in the session's first message, added to the agent's brief as "The operator asks you to focus on", and stored on the run's row as `note` (`src/evidence/runs.ts`, `MAX_RUN_NOTE` and `startInvestigationRun`). The CLI and the route pass it through as `note`.
- A run's session is titled "Investigation · <title>", cut to 100 characters (`src/evidence/runs.ts`, `startInvestigationRun`).
- When the daemon restarts mid-run, the run reads **failed**. Startup recovery marks every session still `running` as `failed` with "interrupted: the daemon stopped mid-turn; send a follow-up to resume" (`recoverOnStartup` in `src/sessions/manager.ts`, called from `src/daemon/lifecycle.ts`), and a run's status is its session's status. A session parked on a usage limit is held again first and stays running, and it resumes by itself at the reset. It takes no follow-up: `send` refuses a parked session (`src/sessions/manager.ts`), and the operator can interrupt it instead. Only the failed session takes a follow-up, which resumes it, and then the run reads running again.
- A run uses the engine and model the project or the CLI flags choose, as other sessions do.

## Unverified

Checked against the code: the run code in `src/evidence/runs.ts` (the preflight refusals and the lead session), the routes in `src/daemon/routes/evidence.ts`, the create form and run list in `web/src/features/evidence/Investigations.tsx`, the CLI in `src/cli/commands/evidence.ts`, and the tests in `tests/evidence.test.ts` ("investigation runs" and the HTTP route tests).

FR-013 and the restart assumption were checked against `src/daemon/routes/evidence.ts`, `src/daemon/server.ts` (a `UserError` answers 400), `src/sessions/manager.ts` (`recoverOnStartup`), and the "/run answers 400 with the same reason" test.

Not checked: the web UI and the CLI end to end, and a real daemon restart in the middle of a run.
