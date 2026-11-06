# Plan: Project memory

- `src/memory/block.ts` managed-block parse and splice (pure).
- `src/memory/detect.ts` correction detection (pure).
- `src/memory/store.ts` list/add/update/delete over the workspace files, plus sync of CLAUDE.md.
- `src/daemon/routes/memory.ts` `GET/POST /api/memory/:root`, `PATCH/DELETE /api/memory/:root/rules/:id`, `POST /api/memory/:root/suggest`.
- Web: `features/memory` (tab, proposal toast), a `memory` tab kind, a palette command, and a hook in the composer's send.
