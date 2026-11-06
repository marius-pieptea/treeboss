# Feature Specification: Checkpoints and rewind

**Feature**: `001-checkpoints-rewind`
**Status**: Implemented; its Checkpoints dialog is superseded by spec 040
**Input**: Snapshot the session's working tree at the end of every turn in a hidden git ref; let the operator rewind to before a turn, or fork a new session from a turn.

## User Scenarios & Testing

### User Story 1 - Rewind to before a turn (Priority: P1)

An agent's turn made a mess. The operator picks the turn in the Checkpoints dialog (superseded by spec 040, which puts rewind on the thread's messages) and chooses "Rewind to before this turn". The working tree (tracked, modified and untracked files) goes back to how it was when that turn began.

**Why this priority**: it is the safety net that makes letting an agent run unattended acceptable.

**Independent Test**: run a turn that edits a tracked file, adds an untracked file and deletes a file; rewind; all three are back as they were.

**Acceptance Scenarios**:

1. **Given** a finished turn 2 that changed files, **When** the operator rewinds to before turn 2, **Then** the files equal the end of turn 1 and a new `undo` checkpoint holds what was thrown away.
2. **Given** a plain (not isolated) workspace, **When** the operator rewinds, **Then** their branch, index and stash are untouched; only files change.
3. **Given** a turn is running, **When** a rewind is requested, **Then** it is refused.

### User Story 2 - Fork a new session from a turn (Priority: P2)

The operator wants to try another approach from the end of turn N without losing the current line of work. "Fork from this turn" opens a new lead in an isolated worktree whose files start exactly at that checkpoint, with a briefing built from the conversation up to turn N.

**Independent Test**: fork from turn 1 of a session that has two turns; the new worktree has turn 1's files, not turn 2's.

### Edge Cases

- A directory that is not a git repository cannot be checkpointed: the feature reports "unavailable" and never fails a turn.
- Ignored files (node_modules, build output) are not captured, and a linked `node_modules` symlink is never captured.
- A turn that changed nothing still gets a checkpoint (the same tree).
- A failed or interrupted turn is checkpointed too.
- The session's repository has no commits yet: checkpoints are created as root commits.

## Requirements

### Functional Requirements

- **FR-001**: After every turn the daemon MUST record a checkpoint: a commit of the full working tree stored under `refs/trb/checkpoints/<session>/<turn>`.
- **FR-002**: Taking a checkpoint MUST NOT change any branch, HEAD, the real index, the stash, or the working tree.
- **FR-003**: Before the first turn of a session a `base` checkpoint MUST be taken so turn 1 can be rewound.
- **FR-004**: Rewind MUST restore tracked, modified, deleted and untracked (non-ignored) files, and MUST first save the current state as an `undo` checkpoint.
- **FR-005**: Rewind MUST NOT move branches or HEAD, and MUST refuse a running, closed or non-git session.
- **FR-006**: The agent MUST be told on its next turn that the files were rewound.
- **FR-007**: Fork MUST create a new lead in an isolated worktree starting at the checkpoint commit, with a transcript briefing limited to turns up to and including the chosen one.
- **FR-008**: The HTTP API MUST expose list, rewind and fork; the UI MUST expose them from a Checkpoints dialog. Superseded by spec 040 (FR-002). The dialog is removed. Rewind is a button on the thread's user messages and fork a button on its agent messages (`web/src/features/checkpoints/ThreadActions.tsx`).
- **FR-009**: Per session, only the newest 100 checkpoints are kept; only refs under the session's own namespace are ever deleted.

### Key Entities

- **Checkpoint**: session, turn, kind (`base`, `turn`, `undo`), ref, commit, tree, file count, time.

## Success Criteria

- **SC-001**: A rewind of a 10k-file repository completes in a few seconds and leaves `git status` equal to the checkpointed state.
- **SC-002**: Taking checkpoints adds no entries to `git branch`, `git stash list` or the real index.

## Assumptions

- Rewind restores files, not the engine's own conversation memory; the next prompt carries a notice.
- Fork is a briefing-based continuation (like a handoff), not an engine-level conversation branch.
