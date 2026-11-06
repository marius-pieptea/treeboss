# Feature Specification: Thread rewind/fork and Verification settings

**Feature**: `040-thread-rewind-fork-and-verify-settings`
**Status**: Implemented
**Input**: Rewind and fork belong on the messages of the conversation, not in a dialog. Verification configuration belongs on a Settings page. Builds on `001-checkpoints-rewind` and `002-verify-before-done`; no daemon changes.

## User Scenarios & Testing

### User Story 1 - Rewind from a user message (Priority: P1)

Each of the user's messages in the thread (Chat, and Trace) has a button on hover or keyboard focus, tooltip "Rewind to before this message". It asks for confirmation that says only the files go back, the agent keeps its memory and is told on its next message, then restores the files to the checkpoint before that message's turn.

**Independent Test**: `scripts/ui-thread-actions.ts`: three turns write files; rewinding the second message restores the first turn's content and removes the file the second turn added.

**Acceptance Scenarios**:

1. **Given** a running session, **Then** every rewind button is `aria-disabled` and its tooltip says to stop the session; clicking does nothing.
2. **Given** a closed session, **Then** rewind is disabled with a tooltip saying fork is still available.
3. **Given** an idle session with a checkpoint, **When** the operator confirms, **Then** `POST /api/sessions/:id/turns/:turnId/rewind` runs and a toast reports what was restored.

### User Story 2 - Fork from an agent message (Priority: P1)

The last agent message of each turn has a "Fork from here" button. The newest agent message shows it always; older ones on hover or focus. It calls `POST /api/sessions/:id/turns/:turnId/fork` and opens the new isolated session. It is disabled, with a reason, until the turn's end checkpoint exists.

### User Story 3 - Touch and keyboard (Priority: P1)

Buttons are real buttons, reachable by Tab, revealed by focus, always visible on devices without hover, and at least 28 px square.

### User Story 4 - Verification settings page (Priority: P1)

Settings has a "Verification" page: global defaults (enabled, off by default and only on when turned on; max auto-fix retries; per-command timeout; command override list) and a per-workspace override (choose the workspace; inherit/on/off, commands, retries, timeout). The per-session on/off switch is a shield in the session header beside Chat | Trace (`VerifyToggle.tsx`). It shows state in its icon and tooltip. "Run checks now" and "Verification settings…" are in the session menu. (This replaces the strip above the composer that this spec first described. The strip no longer exists.) The palette has "Verification settings…".

### Edge Cases

- Messages whose turn has no checkpoint (not a git repository): buttons are disabled with an explanation.
- A head's own transcript is not inside a thread provider and shows no buttons.
- Several text messages in one turn: the fork button is on the last one, the turn's end.
- The palette's "Rewind or fork from a turn…" scrolls to and focuses the newest turn's rewind button.

## Requirements

- **FR-001**: Message-to-turn mapping uses the turn id carried by transcript items; no new endpoints.
- **FR-002**: The Checkpoints dialog is removed; nothing else opened it.
- **FR-003**: Verification stays off by default at every level that is not explicitly turned on.
- **FR-004**: Edits to shared settings files are additive: a page id, a switch case, a sidebar item.
