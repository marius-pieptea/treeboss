# Plan: Design discovery and built-in skills

- `src/design/guidance.ts` the shared text: discovery rules, the direction library, extraction rules, the anti-generic list, the five-dimension critique.
- `src/design/sessions.ts` `brainstorm` option for brief and url: turn 1 asks and writes design/directions.html; the reply turn writes the files. Critique and checklist in every generating prompt and in review.
- `src/design/workspace.ts` `directions` in the design state (html of design/directions.html, size-capped).
- `src/skills/builtin.ts` the shipped skills, built from guidance.ts; seeding (`<trb home>/builtin-skills.json`), status, reset, restore. Seeded from `startServer`.
- Routes: `GET /api/skills` marks built-ins; `POST /api/skills/:name/reset`; `POST /api/skills/restore-builtins`. Design `start` takes `brainstorm`.
- CLI: `trb design start brief "…" [--no-brainstorm]`.
- Web: Brainstorm switch on the composer's design chip (`DesignChip.tsx`, spec 105; it was first in a start dialog); Directions panel (sandboxed srcdoc iframe) in the Design view; built-in badge, reset and restore on the Skills page.
- NOTICE crediting open-design for the adapted ideas.
