# Feature Specification: Session search and replay

**Feature**: `011-session-search-replay`
**Status**: Implemented
**Input**: Full-text search (SQLite FTS5) across every past session's transcript, with workspace, engine and date filters, jump-to-turn, a read-only replay, and a self-contained HTML export with secrets redacted.

## User Scenarios & Testing

### User Story 1 - Find a past conversation (Priority: P1)

The operator opens Session search, types words, optionally filters by workspace, engine and date, and sees hits with the matching words highlighted. Choosing a hit opens the replay at that turn.

**Independent Test**: `GET /api/search/sessions?q=...&engine=...&since=...` returns ranked snippets with `session_id` and `seq`.

### User Story 2 - Replay and export (Priority: P2)

A read-only replay shows every turn (prompt, answer, tool calls). "Export HTML" downloads one file with inline CSS and no scripts or network references.

**Acceptance Scenarios**:

1. **Given** a transcript containing `sk-...` or `ghp_...` tokens, **When** exported, **Then** they appear as `[redacted]`.

### Edge Cases

- A query with FTS syntax characters is treated as plain words, never an error.
- Sessions finished before the index existed are indexed on first search.

## Requirements

- **FR-001**: Index prompts, answers and logged tool lines in an FTS5 table, kept up to date incrementally, never rewriting `events` or `turns`.
- **FR-002**: Filters join `sessions`; workspace matches `base_cwd`.
- **FR-003**: Redaction covers common token shapes, `KEY=value` secrets, bearer tokens, PEM private keys and URL credentials; it is applied to every export. Search results on the local daemon are not redacted.
- **FR-004**: The exported HTML has no script and escapes all content.
