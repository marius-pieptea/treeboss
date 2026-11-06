# Plan: Prompt context palette

- `src/context/`: `resolve.ts` (chips to a block), `search.ts` (files, symbols, commits), `url.ts` (guarded fetch), `images.ts` (stored uploads).
- `src/daemon/routes/context.ts`: `GET /api/context/search`, `POST /api/context/resolve`, `POST /api/context/images`, `GET /api/context/images/:name`. It also folds `context` chips on `POST /api/sessions` and `/api/sessions/:id/send` into the prompt before the core routes run (no edit to core.ts).
- Web: `features/context/` (logic, hook, chips); the composer adds the hook, renders chips, and sends them.
