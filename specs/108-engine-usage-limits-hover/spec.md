# Feature Specification: Engine usage limits on hover

**Feature**: `108-engine-usage-limits-hover`
**Status**: Implemented
**Input**: Hovering the engine icon in the composer shows the plan usage the engine last reported (Claude's windows, Grok's billing period, Cursor's model split), kept across restarts. Claude comes from its own stream. Grok and Cursor are read the way OpenBot reads them.

## User Scenarios & Testing

### User Story 1 - See what is left on my plan from the composer (Priority: P1)

I hover the engine icon in the composer chip. A small card shows the plan windows the engine last reported (for Claude: the 5-hour window, as used percent, what is left, and when it resets) and how long ago that was.

**Why this priority**: knowing the plan is nearly spent decides which engine or model to start the next session on, and that choice is made in the composer.

**Independent Test**: after one claude turn that emitted a `rate_limit_event`, `GET /api/engines/claude/limits` returns its windows with `percent`, `resets_at` and `updated_at`, and hovering the icon shows them.

**Acceptance Scenarios**:

1. **Given** a claude turn reported a 5-hour window at 3% used, **When** I hover the claude icon, **Then** I see "5-hour limit", 3% used, 97% left, the reset time, and "as of" the time it was reported.
2. **Given** the daemon was restarted since, **When** I hover again, **Then** the same snapshot is shown (it is stored, not held in memory).
3. **Given** an engine that never reports (any engine but claude, cursor, grok and codex), **When** I hover its icon, **Then** the card opens and says "This engine does not report plan usage."
4. **Given** a claude snapshot older than its reset time, **When** I hover, **Then** the daemon has dropped that window, so the card shows only the windows still good, or "Nothing reported yet. It updates after the next turn." when none are left, and no stale percentage. A window whose reset time passes while the card is open reads "reset since", with no bar and no reset time, until the card is opened again.

### User Story 2 - Honest about what is unknown (Priority: P2)

An engine that can report limits but has not yet done so says so, instead of showing nothing or a made-up number.

**Independent Test**: with no stored snapshot for claude, the card reads "Nothing reported yet. It updates after the next turn."

**Acceptance Scenarios**:

1. **Given** no claude turn has run since install, **When** I hover the claude icon, **Then** the card says nothing has been reported yet and when it will update.

### Edge Cases

- A `rate_limit_event` without `unifiedWindows` still records its `rateLimitType`, `status` and `resetsAt`, with no percentage.
- A status of anything other than `allowed` (for example a limit reached) is shown with a warning word, not only a color.
- Several sessions on the same engine: the newest event wins.
- Percent comes as a 0..1 fraction on the stream and is stored as 0..100.

## Requirements

### Functional Requirements

- **FR-001**: The daemon MUST capture plan windows from the engine itself. Claude's come from `rate_limit_event` during a turn. Grok's come from `_x.ai/billing` on a short `grok agent stdio` session. Cursor's come from the dashboard calls the Cursor CLI sends, using the token in the CLI's auth file. That token MUST NOT be logged or stored. Codex's come from the newest session rollout under `~/.codex/sessions`; no credential is read. See spec 121.
- **FR-002**: The latest snapshot per engine MUST be stored and survive a daemon restart.
- **FR-003**: `GET /api/engines/:id/limits` MUST refresh Grok, Cursor and Codex readings when the route is called, at most once every 5 minutes, including after a miss. It MUST then return `engine`, `exposed`, `windows` and `updated_at`. `windows` MUST hold only readings still good. A window is dropped once its reset time has passed, or an hour after it was reported when it names no reset time. `windows` MUST be an empty list, with `updated_at` null, when nothing is stored or every window has been dropped. `exposed` MUST be true for an engine that can report (claude, cursor, grok and codex), whether or not it has, and false for any other engine. An unknown engine MUST answer 404.
- **FR-004**: The composer MUST show the snapshot in a card on hovering the engine icon, with the time it was reported, and MUST update it when a new one is captured.
- **FR-005**: The card MUST use design tokens only.

### Key Entities

- **Limits snapshot**: an engine id, a list of windows (id, title, percent used, reset time, status) and the time it was captured.

## Success Criteria

- **SC-001**: After one claude turn, the usage card shows its 5-hour window without any other action.
- **SC-002**: The only credential read is Cursor's auth file, and only to send Cursor's own dashboard request. It is not logged or stored. `.credentials.json` and the Keychain are not read.

## Assumptions

- Claude's stream carries limits (`rate_limit_event`). Grok, Cursor and Codex report through the reads in FR-001. OpenCode and Antigravity do not report plan windows. Codex's source is specified in [spec 121](../121-plan-usage-every-engine/spec.md).
- Claude's numbers are as fresh as the last turn. Grok, Cursor and Codex refresh when their limits route is read, at most every 5 minutes, including after a miss.
