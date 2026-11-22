# Feature Specification: Devin plan usage

**Feature**: `122-devin-plan-usage`
**Status**: Draft
**Input**: Extends the engine Usage hover card (spec 108, spec 121) to Devin. The card shows Devin's daily and weekly quota (percent used and reset time), read from the Devin CLI's own cached plan status, with no sign-in read and no network call. Devin's extra usage balance is out of scope.

## User Scenarios & Testing

### User Story 1 - See Devin's daily and weekly quota from the composer (Priority: P1)

I hover the Devin icon in the engine rail. The Usage card shows "Daily quota" and "Weekly quota" the way it shows Claude's windows: the percent used, when each resets, and "as of" when Devin last fetched them.

**Why this priority**: Devin's quota resets daily and weekly. Seeing how much is left decides whether the next session or Hydra head runs on Devin or on another engine.

**Independent Test**: after Devin has started once on this machine, `GET /api/engines/devin/limits` returns `exposed: true` and two windows, `daily` and `weekly`, each with `percent`, `resets_at` and `updated_at`, and hovering the icon shows them.

**Acceptance Scenarios**:

1. **Given** Devin's cached plan status says 94% of the daily quota and 97% of the weekly quota remain, **When** I hover the Devin icon, **Then** I see "Daily quota" 6% used and "Weekly quota" 3% used, each with its reset time, in that order.
2. **Given** Devin has never run on this machine (no cached plan status), **When** I hover, **Then** the card reads "Nothing reported yet. It updates after the next turn."
3. **Given** the daily quota is used up, **When** I hover, **Then** the daily row reads 100% used and says the limit is reached in words, not only by color (spec 108).
4. **Given** the daemon restarted, **When** I hover, **Then** the stored snapshot is shown (spec 108 FR-002).

### Edge Cases

- The cached plan status omits a remaining-percent field while its reset time is present: protobuf leaves out zero values, so that window is 100% used.
- A window whose reset time has passed is dropped, as for every engine (`live()` in limits.ts).
- Several cached files (one per signed-in identity): the newest by its own fetch time wins.
- An unknown envelope version, a corrupt file or a format change after a Devin update: no windows from this read, and the previous snapshot stays. Never an error in the card.
- A long-running Devin session does not refresh the cache; the "as of" time is the cache's own fetch time, so the card does not claim to be fresher than it is.

## Requirements

### Functional Requirements

- **FR-001**: The daemon MUST read Devin's quota only from the plan status the Devin CLI caches for itself (`user_status.<digest>.bin` in the CLI's cache folder: `%LOCALAPPDATA%\devin\cli` on Windows; the macOS and Linux folders are candidates until verified). It MUST NOT open Devin's credentials and MUST NOT make any network call.
- **FR-002**: From that file the daemon MUST take only the plan status's daily and weekly remaining percent and their reset times. The file also holds the user's name, email and organization; none of it is stored, logged or returned.
- **FR-003**: Each window is stored as a spec-108 limits window: `daily` "Daily quota" and `weekly` "Weekly quota", percent used = 100 − remaining (clamped to 0..100), `resets_at` from the file, "as of" = the file's own fetch time. The read is refreshed by `GET /api/engines/devin/limits` at most every 5 minutes (spec 108 FR-003) and replaces the earlier snapshot.
- **FR-004**: `exposed` MUST be true for devin, on the server and in the web's mirrored list.
- **FR-005**: The card is unchanged in look. It reuses spec 108's rows and design tokens, with no new tokens. Daily sorts before weekly.

### Key Entities

- **Devin plan status cache**: a JSON envelope (`version`, `identity_digest`, `fetched_at_secs`, `payload`) whose base64 `payload` is the CLI's own GetUserStatus protobuf. Plan status is field 13; daily and weekly remaining percent are its fields 14 and 15; their reset times (epoch seconds) are fields 17 and 18. Field numbers were read from the live file and the names embedded in the devin binary (CLI 3000.12.x), not from a published schema.
- **Limits snapshot**: as in spec 108.

## Success Criteria

- **SC-001**: After Devin has started once, the Usage card for Devin shows its daily and weekly quota without any other action, matching what Devin's own app shows for the same moment.
- **SC-002**: No credential is read and no request leaves the machine to get these numbers.

## Assumptions

- The cache format is private to the Devin CLI and may change. A format change shows as "no new reading", not as wrong numbers or an error.
- Only the Windows cache path is verified (this machine). The macOS and Linux paths are best guesses tried in order.
- Extra usage balance stays out, so there is nothing new to design; the canvas step is skipped for that reason.
