# Feature Specification: Project memory

**Feature**: `101-project-memory`
**Status**: Implemented
**Input**: An auto-maintained, engine-agnostic conventions store per workspace that every engine reads.

## User Scenarios & Testing

### User Story 1 - Save a correction as a rule (Priority: P1)
When I tell the agent "we use bun, not npm", the app proposes saving it as a project rule. I can accept, edit or dismiss.

**Acceptance**: a message that reads as a standing convention yields a proposal; an ordinary request yields none; a rule that is already saved is not proposed again.

### User Story 2 - Every engine reads the rules (Priority: P1)
Accepted rules are written into AGENTS.md (and CLAUDE.md) inside one delimited block, so claude, codex and cursor all pick them up.

**Acceptance**: hand-written content outside the block is never changed, byte for byte; a missing file is created containing only the block; a CLAUDE.md that imports AGENTS.md (`@AGENTS.md`) is left alone.

### User Story 3 - Manage rules (Priority: P2)
A Memory tab lists, edits, adds and deletes rules.

## Requirements
- The block is delimited by `<!-- trb:memory:start -->` and `<!-- trb:memory:end -->`; the rules inside are the only source of truth (no database table), so they travel with git.
- Only the block is ever rewritten; a block someone damaged (start without end) is refused, not repaired.
- Writes are atomic and stay inside the workspace root.
- Correction detection is a pure, conservative heuristic; it proposes, it never saves by itself.
