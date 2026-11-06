# Tasks: pstack in the core

## Phase 0: Spec, README and roadmap

- [x] T001 Spec, plan and tasks for 120-pstack, in the format of 117 and 118
- [x] T002 ROADMAP item in Now, linked to this spec and to the README
- [x] T003 README pstack subsection under Specialized agents: what it is, that it ships built in, the team, cost, credit and license

## Phase 1: Vendor the pack

- [x] T004 `scripts/vendor-pstack.ts`: one argument; copies the listed upstream skill folders minus the `exclude` globs, plus the LICENSE, verbatim with LF line endings; writes version and commit into pack.json; warns about unlisted and gone upstream folders; never touches `local/`; no network (FR-016). *(`--pack` and `--hashes-only` exist. `--dry-run` and `--commit` are planned.)*
- [x] T005 Run it on commit c742dd6: `src/skills/packs/pstack/` holds 56 listed skill folders, LICENSE and pack.json (version 0.15.36, the commit, the skills list, the `exclude` and `local` keys) (FR-001, FR-002)
- [x] T006 pstack entry in NOTICE with the URL, version and the MIT text; the root LICENSE is untouched (FR-005). The commit is in pack.json, not in NOTICE.
- [x] T007 Packaging: `desktop/stage.ts` copies the packs, `desktop/electron-builder.yml` places them beside the daemon in the app resources, `desktop/main.cjs` passes `TRB_PACKS_DIR` (Assumptions)
- [x] T008 Hash and exclusion checks: a changed vendored file and an excluded skill each fail, naming the file (FR-004). pack.json records `hashes`, and `verifyPackFiles` in src/skills/packs.ts is checked by tests/skills-packs.test.ts.

## Phase 2: Seed the pack as built-ins

- [x] T009 `src/skills/packs.ts`: `packsRoot()` and `loadPacks()`; loads the `skills` and `local` lists; applies the `exclude` globs as it reads; a broken pack is logged and skipped (FR-006)
- [x] T010 `seedBuiltinSkills` seeds the pack's skills through the same list as the five inline built-ins; a name you already use is never overwritten (FR-006). *(Files that are not text are not copied; see the planned follow-ups.)*
- [x] T011 The update rule in `seedBuiltinSkills`, with `seeded` and `hashes` in `<home>/builtin-skills.json` (FR-007)
- [x] T012 Restore and Reset cover the pack's skills through `builtinSkills()`; Settings > Skills shows "built-in, edited" for a copy you changed (FR-006, FR-007)
- [x] T013 A skill the pack list no longer names: an unedited copy is removed on the next start, and an edited copy is kept and flagged as retired. The origin of each seeded name is recorded, and a pack that failed to load retires nothing (src/skills/builtin.ts).

## Phase 3: Adapter and built-in agents

- [x] T014 The adapter `local/pstack-treeboss/SKILL.md` and `references/claude-code-adapter.md` are merged, and the name map and skip lines are in place. The role map names the recipe roles explorer, architect, builder, verifier and cleaner with their agents (SKILL.md lines 30 to 40). The library roles stay only as the fallback for any other roles pair (lines 42 to 50) (FR-008).
- [x] T015 The five agents as data in `src/agents/pstack.ts`, each with an explicit skills list and no engine, model or effort (FR-009). They are not vendored files: poteto-agent and comment-sicko are authored texts that carry the attribution line.
- [x] T016 `src/agents/builtin.ts`: seed, restore, reset, the update rule and `claimBuiltinName`, with `<home>/builtin-agents.json` holding each built-in's name and fingerprint (FR-007, FR-009). The agents store has no `source` column.
- [x] T017 Routes and the Agents page: `GET /api/agents` (builtin, modified, missingBuiltins), `POST /api/agents/restore-builtins`, `POST /api/agents/:name/reset`; the Built-in and "Built-in, edited" badges, Reset to default, and "Restore built-in agents (N)" (FR-017). *(The CLI and the missing-skill marker are planned.)*

## Phase 4: Team recipes and lead instructions

- [x] T018 `lead_instructions` on pairs: the column added in `src/db.ts`, the 2,000-character check on create and update, the pair routes, and the "Lead instructions" textarea with its counter in `PairEditor.tsx` (FR-012). *(The CLI flag is planned.)*
- [x] T019 `leadTurnPreamble` adds "How this pair works:" after the fan-out and collect rules, before the heads still open (FR-012)
- [x] T020 The two recipes in `PAIR_COOKBOOK`, with the values in plan.md: the Codex recipe runs the builder on Codex; every role carries its own instruction line (FR-010, FR-011)
- [x] T021 The shared lead text, `PSTACK_LEAD`; a test checks its length against the cap (FR-013). *(The FAIL and PASS-only rules are planned; see the follow-ups.)*
- [x] T022 `fromCookbook` checks each recipe role's agent before it creates the pair, and throws the restore message naming the recipe, the role and the agent (FR-014). Head creation is unchanged.

## Phase 5: Practice pack

- [x] T023 `pstack` in `src/practices/packs.ts`: eight rules, nine principle skills, applies to any stack, no checks, off until enabled (FR-015)
- [x] T024 Practice block: enabling writes the heading, the rules and the skill lines; disabling removes them (`tests/practices.test.ts`) (FR-015)

## Phase 6: Tests and proof

- [x] T025 Tests for the merged parts: `tests/skills-packs.test.ts`, `tests/skills-builtin.test.ts`, `tests/agents-builtin.test.ts`, `tests/pairs.test.ts`, `tests/practices.test.ts`, `tests/web/settings.test.ts`, `tests/skill-packs-api.test.ts` and `tests/web/skillsui.test.ts`. None starts a model (FR-018). `tests/pstack-integration.test.ts` also exists. It checks what the pstack set names is shipped, and that on an empty home seeding the skills and then the agents works and both recipes build. It does not check the adapter's role lines against the recipes, a second start, a daemon start or `trb pair recipes`.
- [x] T026 Vendor-script test: the copy, the warnings, a refusal for a checkout that is not pstack, and a second run that leaves the same files (tests/vendor-pstack.test.ts, which also covers `--hashes-only` and `--pack`).
- [ ] T027 `bun test` and `bun run typecheck` pass on main (SC-002). Typecheck (root and web) passes. The full `bun test` on Windows has 133 consistent failures, all of which also fail on clean main (Windows environment: /bin/sh spawns, symlink EPERM, CRLF, path separators, POSIX modes, CodeGraph and Tailscale not present), so SC-002 needs a POSIX or CI run.
- [x] T028 Proof on an empty `TRB_HOME`: the first daemon start seeds the pack's skills and the five agents, the second adds nothing, and `trb pair recipes` lists both recipes (SC-003, SC-004). Verified by an independent run: the first start seeded 62 built-in skills (57 pstack: 56 vendored plus pstack-treeboss, and 5 inline) and the five agents; the second start on the same home added nothing (builtin-skills.json and builtin-agents.json sha256 unchanged, no duplicates, no retire log lines); `trb pair recipes` listed pstack-claude and pstack-claude-codex.

## Phase 7: Merged after the first draft

- [x] T029 Curation: pack.json lists 56 upstream skills and the `local` adapter, and its `exclude` drops statechart's test corpus (`statechart/scripts/test/**`, 376 files, not on disk). So 57 pack skills ship (FR-003, FR-016)
- [x] T030 Status digests are memoized: a copy is remembered by its file stats, a copy written in the last 2 seconds is read again, and each built-in's shipped digest is computed once per process (FR-019)
- [x] T031 Settings > Skills: one collapsible section per pack, collapsed by default, with its version, license, author, upstream link and counts, Enable all and Disable all; pack skill rows carry the pack badge; a search opens the packs it matches (FR-017)
- [x] T032 Routes: `GET /api/skills/packs` and `POST /api/skills/packs/:id/enabled` in `src/daemon/routes/x_settings.ts`, backed by `src/skill-packs.ts` (FR-017)
- [x] T033 CLI: `trb skill packs` and `trb skill pack <id> on|off` (FR-017)

## Planned follow-ups (not counted)

Not built: `trb pair add|edit --lead-instructions` (FR-012); `trb agent restore` and `trb agent reset <name>` (FR-017); refusing a head whose role's agent was deleted (FR-014, already a follow-up); the lead text's FAIL and PASS-only rules (FR-013); a "missing skill" marker on the Agents page (FR-017); copying non-text files in a skill folder as bytes (FR-001); the rest of `tests/pstack-integration.test.ts` (the adapter cross-check against the recipes' roles, and a second start that adds nothing).
