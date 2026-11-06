# Feature Specification: Verify before done

**Feature**: `002-verify-before-done`
**Status**: Implemented; its settings section is superseded by spec 040
**Input**: After each turn the daemon runs the project's verify commands (typecheck, lint, test), shows the results, feeds failures back to the agent as the next turn within a bounded number of retries, and only calls a session done when verification passes. Integrated with goal mode.

## User Scenarios & Testing

### User Story 1 - The agent is told when it broke something (Priority: P1)

A turn ends. The daemon detects `typecheck`, `lint` and `test` scripts in package.json, runs them in the session's directory, and, when one fails, sends the output back to the agent as the next turn. This repeats up to N times (default 2).

**Why this priority**: it is what turns "the agent said it is done" into "the project is green".

**Independent Test**: a turn leaves a failing check; the next turn's prompt contains the failure output; the turn after fixes it; the session ends verified.

**Acceptance Scenarios**:

1. **Given** a failing verify command and retries left, **When** a turn ends, **Then** the next turn starts automatically with the command and its output.
2. **Given** retries are used up, **When** the last retry still fails, **Then** the loop stops, the state is `failed`, and the reason is logged.
3. **Given** every command passes, **When** the turn ends, **Then** the state is `passed` and the UI shows Done.

### User Story 2 - Control (Priority: P1)

The operator can switch verification off globally, per workspace, or per session, override the commands and the retry count per workspace, and run it by hand.

### User Story 3 - Goal mode (Priority: P2)

A goal is not met while verification fails, even when its check passes or the agent says DONE; the goal's next turn carries the verification failure.

### Edge Cases

- No commands detected: nothing runs, state `none`, the session is never labelled Done.
- A command hangs: killed at the timeout (default 300 s) and reported as a failure.
- Nothing changed since the last verified tree: the previous result is reused.
- An auto-fix turn changes nothing: the loop stops instead of repeating itself.
- The operator sends a message while verification runs: the result is recorded as stale and no follow-up is sent.
- Ask and plan mode sessions, subagents, failed and interrupted turns are not verified.

## Requirements

### Functional Requirements

- **FR-001**: Commands MUST be auto-detected from package.json scripts (typecheck, lint, test; runner by lockfile), Cargo.toml, go.mod and Python configs, unless overridden in the workspace's verify settings.
- **FR-002**: Settings MUST resolve session > workspace > global, with an off switch at each level.
- **FR-003**: Failures MUST be fed back as the next turn at most `max_retries` times in a row; an operator turn resets the count.
- **FR-004**: Results (per command: exit code, duration, output tail) MUST be stored per turn and shown in the UI.
- **FR-005**: A session view MUST report `verify.state` and `done`; `done` is true only when the state is `passed`.
- **FR-006**: Goal evaluation MUST treat a failing verification as "not met".
- **FR-007**: The operator MUST be able to run, stop and configure verification over HTTP and in the UI.

### Key Entities

- **Verify run**: session, turn, state, per-command results, fingerprint, attempt number.
- **Verify config**: scope (global or workspace path), enabled, commands, max retries, timeout.

## Success Criteria

- **SC-001**: With retries 2, a failing project causes at most 2 automatic follow-up turns per operator turn.
- **SC-002**: With verification off, no command is ever run.

## Assumptions

- Default is on, because detection runs nothing when a project has no recognizable commands.
