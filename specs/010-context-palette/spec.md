# Feature Specification: Prompt context palette

**Feature**: `010-context-palette`
**Status**: Implemented
**Input**: In the composer, `@` offers files, symbols, commits, URLs, the last terminal output, the preview's console errors, and pasted or dropped images, as chips resolved by the daemon so every engine receives the context as text or a file path.

## User Scenarios & Testing

### User Story 1 - Attach context with `@` (Priority: P1)

The operator types `@` in the composer and fuzzy-picks a file, a symbol, a commit, or one of `url`, `terminal`, `browser`. The pick becomes a chip under the text box and leaves the sentence untouched.

**Independent Test**: `GET /api/context/search?root=...&q=...` returns ranked candidates; `POST /api/context/resolve` returns the text block for a list of chips.

**Acceptance Scenarios**:

1. **Given** an indexed workspace, **When** the operator types `@parseCfg`, **Then** symbols matching fuzzily are offered (CodeGraph); in an unindexed workspace a plain text search offers definitions instead.
2. **Given** chips on a message, **When** it is sent, **Then** the daemon prepends one `# Attached context` block to the prompt, whichever engine runs the turn.

### User Story 2 - Images (Priority: P2)

Pasting or dropping an image uploads it to the daemon, shows a chip with a thumbnail, and the prompt carries the saved file's absolute path.

### Edge Cases

- `@url` of localhost, a private or link-local address, or a non-http scheme is refused (every redirect hop is re-checked); the preview URL is allowed only when the caller names it explicitly.
- Oversized responses are cut at a byte cap; non-text content types are refused.
- A chip that fails to resolve becomes a one-line note in the block, never a failed send.
- Paths outside the workspace are refused.

## Requirements

- **FR-001**: Resolution happens in the daemon; the web only sends `{kind, value}` chips.
- **FR-002**: `@url` MUST resolve the host and refuse loopback, private, link-local and unique-local addresses, re-checking every redirect hop, and cap the body.
- **FR-003**: `@terminal` returns the tail of a terminal's scrollback with ANSI stripped; `@browser` returns the preview console errors when that buffer exists, else a stub note.
- **FR-004**: Every block is length-capped so one chip cannot flood the context window.
