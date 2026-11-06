# Feature Specification: Plan usage for every engine

**Feature**: `121-plan-usage-every-engine`
**Status**: Implemented (Codex), not committed
**Input**: Extends the engine Usage hover card (spec 108) beyond Claude, Grok and Cursor. Codex reports its plan windows from the `rate_limits` it puts on its own `token_count` events. OpenCode and Antigravity have no supported source yet and keep saying so.

## User Scenarios & Testing

### User Story 1 - See Codex's plan usage from the composer (Priority: P1)

I hover the Codex icon in the engine rail. The Usage card shows the windows Codex last reported, the same way it does for Claude: the window name, the percent used, when it resets, and "as of" when it was reported.

**Why this priority**: Codex is the one engine besides Claude, Grok and Cursor whose plan usage is already in its own output. On this machine it is a Go plan with a 30-day window. Seeing it decides which engine the next session runs on.

**Independent Test**: after one codex turn, `GET /api/engines/codex/limits` returns `exposed: true` and one or two windows with `percent`, `resets_at` and `updated_at`, and hovering the icon shows them.

**Acceptance Scenarios**:

1. **Given** a codex turn reported `primary: { used_percent: 6, window_minutes: 43200, resets_at: T }`, **When** I hover the Codex icon, **Then** I see "Monthly limit", 6% used, the reset time T, and "as of" the time it was reported.
2. **Given** a codex turn reported a 300-minute primary and a 10080-minute secondary window, **When** I hover, **Then** I see "5-hour limit" and "Weekly limit" as two rows.
3. **Given** no codex turn has run since install, **When** I hover, **Then** the card reads "Nothing reported yet. It updates after the next turn."
4. **Given** the daemon restarted, **When** I hover, **Then** the stored snapshot is shown (spec 108 FR-002).

### User Story 2 - Honest about engines that cannot report (Priority: P2)

OpenCode and Antigravity keep the card's "This engine does not report plan usage." Their output has no limit windows, so we show no made-up numbers.

**Acceptance Scenarios**:

1. **Given** the OpenCode or Antigravity icon, **When** I hover, **Then** the card says "This engine does not report plan usage."

### Edge Cases

- `secondary` is null: only the primary window is shown.
- A window length with no fixed name is titled from its length ("N-hour limit", "N-day limit").
- `used_percent` above 100 is clamped to 100, and the status reads as a limit reached, in words and not only by color (spec 108).
- `spend_control_reached` truthy: the status is "limit reached".
- Older codex versions that give `resets_in_seconds` instead of `resets_at`: the reset time is the reading time plus that.
- A `token_count` event without `rate_limits` leaves the stored snapshot as it is.

## Requirements

### Functional Requirements

- **FR-001**: The daemon MUST capture Codex plan windows from Codex's own output: the `rate_limits` on the latest `token_count` event (`primary` and `secondary`, each `used_percent`, `window_minutes`, `resets_at`) in the newest session rollout under `~/.codex/sessions` (newest YYYY/MM/DD folder first, read from the file's tail). The read is refreshed by `GET /api/engines/codex/limits` at most every 5 minutes (spec 108 FR-003). A window's "as of" time is the rollout line's own `timestamp`, not the time it was read. `~/.codex/auth.json` and other credentials MUST NOT be read.
- **FR-002**: Each window is stored as a spec-108 limits window, merged by window id with the earlier snapshot. The title comes from the window length: 300 minutes is "5-hour limit", 10080 is "Weekly limit", 43200 is "Monthly limit".
- **FR-003**: `exposed` MUST be true for codex. It stays false for opencode and agy.
- **FR-004**: The card is unchanged in look. It reuses spec 108's rows and design tokens, with no new tokens.

### Key Entities

- **Limits snapshot**: as in spec 108. Codex adds windows whose id comes from their length.

## Success Criteria

- **SC-001**: After one codex turn, the Usage card for Codex shows its plan window(s) without any other action.
- **SC-002**: No new credential is read. Codex's numbers come from its own event stream or session files.

## Assumptions

- Codex 0.165 puts `rate_limits` on `token_count`, as seen in this machine's session rollouts (Go plan, 30-day window).
- OpenCode (signed in to OpenCode Go) and Antigravity (agy 1.4.11) give no limit windows in their stream or CLI. OpenCode's `stats` command is history only. Any other source (OpenCode Go's console, Antigravity's language server or Google's quota API) would need an unofficial endpoint or the user's OAuth token. That needs the operator's decision and its own spec.
