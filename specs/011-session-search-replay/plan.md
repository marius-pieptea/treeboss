# Plan: Session search and replay

- `src/search/index.ts`: creates `transcript_fts` (FTS5) and `transcript_index` lazily (idempotent), indexes incrementally, queries with filters. No edit to `db.ts`.
- `src/search/redact.ts`, `src/search/export.ts` (self-contained HTML).
- `src/daemon/routes/search.ts`: `GET /api/search/sessions`, `GET /api/search/sessions/:id/replay`, `GET /api/search/sessions/:id/export.html`.
- Web: a `transcripts` tab kind (`features/transcripts/`) opened from the command palette and the activity bar; replay is a second view in the same tab.
