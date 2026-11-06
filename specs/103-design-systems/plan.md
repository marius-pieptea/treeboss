# Plan: Design systems

- `src/design/contract.ts` the token contract, the AGENTS.md rule, and a tokens.css parser (swatches for the UI).
- `src/design/builtins.ts` four original systems, DESIGN.md and tokens.css built from one small spec each.
- `src/design/library.ts` the library store (`<trb home>/design-systems.json`): seeded defaults, validation, save, delete, reset, restore, reorder.
- `src/design/workspace.ts` a project's DESIGN.md + design/tokens.css: read into a view, apply from the library (overwrite only when asked), save to the library, add the agent rule.
- `src/design/prompts.ts` + `src/design/sessions.ts` sessions for brief / url / codebase generation, wire and review.
- `src/scaffold/run.ts` `designSystem` input: written before the first commit, rule added, starter prompt extended.
- `src/daemon/routes/design.ts`
  - `GET/POST /api/design/systems`, `PUT/DELETE /api/design/systems/:id`, `POST /api/design/systems/:id/reset`, `POST /api/design/systems/restore-defaults`, `POST /api/design/systems/reorder`
  - `GET /api/design/:root`, `POST /api/design/:root/apply`, `POST /api/design/:root/rule`, `POST /api/design/:root/save-to-library`, `POST /api/design/:root/start`
- `src/cli/commands/design.ts` `trb design [show|systems|apply|start]`.
- Web: `features/design/` (Design tab, library settings page, swatches), New app picker, activity bar, commands.
