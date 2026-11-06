# Plan: Templates and scaffolding

- `src/scaffold/recipes.ts` built-ins, user recipes (`<trb home>/recipes.json`), validation.
- `src/scaffold/run.ts` safety checks, steps, jobs, injectable runner.
- `src/daemon/routes/scaffold.ts` `GET/POST/DELETE /api/scaffold/recipes`, `POST /api/scaffold/run`, `GET /api/scaffold/jobs/:id`.
- Web: a "New app" panel on the home screen (`NewAppPanel`, mounted in `web/src/shell/Home.tsx`).
