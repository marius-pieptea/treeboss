# Plan: pstack in the core

Paths are as they are on main. *(planned)* marks work not started.

## Pack and vendoring

- `src/skills/packs/pstack/pack.json`: `id`, `title`, `version` (0.15.36), `author`, `license`, `upstream`, `commit` (c742dd6), `skills` (56 names), `exclude` (`["statechart/scripts/test/**"]`) and `local` (`["pstack-treeboss"]`). `hashes` (a SHA-256 for every file under `skills/` and the LICENSE).
- `src/skills/packs/pstack/LICENSE`: upstream's MIT license with its copyright line.
- `src/skills/packs/pstack/skills/<name>/`: the 56 listed skill folders, text with LF line endings and executable bits kept. statechart has no `scripts/test` on disk.
- `src/skills/packs/pstack/local/pstack-treeboss/SKILL.md` and `references/claude-code-adapter.md`: the adapter. Its role map names the recipe roles explorer, architect, builder, verifier and cleaner with their agents, and keeps the library roles only as the fallback for any other roles pair.
- The pack folder holds 161 files and 696,623 bytes: 157 skill files, the adapter's 2, LICENSE and pack.json.
- `scripts/vendor-pstack.ts`: the re-sync, `bun scripts/vendor-pstack.ts <checkout>`. It needs an existing pack.json and refuses before writing if the checkout is not pstack, HEAD is not a commit, or the upstream skills or LICENSE are missing. It copies the listed folders minus the `exclude` globs, keeps the executable bits git records, and writes `version` and `commit` back into pack.json. It warns about unlisted and gone upstream folders, never touches `local/`, and prints one summary line.
- `NOTICE`: the pstack entry, with the URL, the version, the agents and recipes it adapts, and the MIT text. The commit is in pack.json, not in NOTICE.
- `tsconfig.json` excludes `src/skills/packs`. `.gitattributes` has `src/skills/packs/** text eol=lf`.
- `desktop/stage.ts` copies `src/skills/packs` to `stage/packs`. `desktop/electron-builder.yml` puts `stage/packs` in the mac and win extraResources as `packs`. `desktop/main.cjs` passes `TRB_PACKS_DIR`.

## Loader and built-ins

- `src/skills/packs.ts`: `packsRoot()` reads `TRB_PACKS_DIR`, then `src/skills/packs` beside the source, then `packs/` in the folder above the binary's folder. `loadPacks()` reads each folder's pack.json, loads the `skills` and `local` entries, applies the `exclude` globs as it reads, and logs and skips a broken pack.
- `src/skills/files.ts` `walkSkillDir` (existing): leaves out `.git`, `node_modules`, `.DS_Store`, `__pycache__` and `.venv`, reports symlink loops, broken links and nesting too deep, and caps counts and sizes.
- `src/skills/builtin.ts`: `builtinSkills()` is the five inline built-ins, then the pack skills, first one wins on a name. `seedBuiltinSkills` runs the FR-007 update rule over `<home>/builtin-skills.json` (`seeded`, `hashes`). `install` writes the text, sets 0755 on executables and records the shipped digest. `builtinStatus` returns `builtin`, `modified` and `pack`. `resetBuiltinSkill`, `missingBuiltinSkills` and `restoreBuiltinSkills` use the same list.
- Digests: `contentHash` is a sha256 over the sorted paths and their text, CRLF read as LF. `shippedHash` is cached per built-in for the life of the process. `installedHash` is cached per directory, keyed by each file's name, size, modified and changed times. A copy with a file written in the last 2 seconds (`RACY_MS`) is read again.
- `src/skill-packs.ts`: `listSkillPacks()` gives each pack its manifest fields, its skills and its installed and enabled counts, sorted by title. `setSkillPackEnabled(id, on)` switches a pack's installed skills in one transaction, and returns null for an unknown pack. A pack's installed skills are the store records that are built-ins of that pack.
- `src/skills/store.ts`: `SkillStore.register` inserts new skills enabled. `defaultSkillNames` resolves `default_skills` (`all`, `builtin`, `none`, or names). `materializeSkills` links each skill into the workspace per turn (copies when `skills_link` is off), and lists the skills in the prompt for an engine with no skills folder. The comment on `defaultSkillNames` says the whole library is never the default; the setting's default is `all`, so the comment is out of date.
- `src/settings.ts`: `default_skills` defaults to `all`, and `skills_link` to `on`.

## Agents

- `src/agents/pstack.ts`: `PSTACK_AGENTS`, the five agents as data, each with its explicit skills list, its instruction text and the attribution line. The 24 principle skill names are listed once and reused.
- `src/agents/builtin.ts`: `BUILTIN_AGENTS` (= `PSTACK_AGENTS`), `seedBuiltinAgents` (the update rule), `builtinAgentStatus`, `missingBuiltinAgents`, `resetBuiltinAgent`, `restoreBuiltinAgents` and `claimBuiltinName`. `storable` leaves out any skill or MCP server that is not installed, with a log line. The state file `<home>/builtin-agents.json` is `{"seeded": {name: fingerprint | null}}`. A fingerprint is the first 16 hex characters of a sha256 over the agent's fields.
- `src/agents/store.ts`: no `source` column. A built-in is one whose name is recorded in `builtin-agents.json`.

## Pairs and sessions

- `src/db.ts` `migrate()`: `addColumn` adds `pairs.lead_instructions` (TEXT).
- `src/hydra/pairs.ts`: `LEAD_INSTRUCTIONS_CHARS` (2,000); `leadInstructionsOf` (checks the length before trimming, and blank means none); `PSTACK_LEAD` and `PSTACK_ROLE_NOTE`; the two recipes in `PAIR_COOKBOOK`; `fromCookbook` (checks each role's agent and gives the restore message); `leadTurnPreamble` (adds "How this pair works:" after the fan-out and collect rules, before the heads still open). `normalizeInput` keeps its own generic message for custom pairs.
- `src/sessions/manager.ts`: unchanged for this feature. `createChild` refuses an unknown role with the pair's roles listed. Refusing a head whose agent was deleted is *(planned)*.

## Daemon, routes and CLI

- `src/daemon/lifecycle.ts` `runDaemon`: migrates the database, seeds the skills, then seeds the agents. Each step is wrapped, so a failure is logged and the daemon starts.
- `src/daemon/routes/x_settings.ts`: `GET /api/skills/packs`; `POST /api/skills/packs/:id/enabled` (400 when `enabled` is not a boolean, 404 for an unknown pack); `POST /api/skills/restore-builtins`; `POST /api/skills/:name/reset`.
- `src/daemon/routes/core.ts`: `GET /api/skills` (with the built-in fields and `missingBuiltins`); `POST /api/pairs` (with `recipe`, through `fromCookbook`; otherwise `create`).
- `src/daemon/routes/agents.ts`: `GET /api/agents` (with `builtin`, `modified`, `missingBuiltins`); `POST /api/agents` (calls `claimBuiltinName` on create); `POST /api/agents/restore-builtins`; `POST /api/agents/:name/reset`.
- `src/cli/commands/config.ts`: `trb skill packs`; `trb skill pack <id> on|off`; `trb pair add --recipe`. The pair CLI has no `--lead-instructions` flag *(planned)*, and there is no `trb agent restore|reset` *(planned)*.
- `src/practices/packs.ts`: the `pstack` entry: eight rules, nine principle skills, `appliesTo: ["any"]`, no checks.

## Web (web/src/features/settings/)

- `SkillsPage.tsx`: one section per pack, collapsed by default (`openPacks`); a search opens the packs it matches; selecting a pack skill opens its pack; Reset; "Restore built-in skills (N)"; "built-in, edited".
- `skills-list.tsx`: `PackGroup` (a chevron header with the title and counts, then version, license, author and the upstream link when it is http(s), then Enable all and Disable all, then the installed skills); the pack badge on a pack skill's row.
- `skills-logic.ts`: `packSections`, `packActions`, `packCountText`, `unpackedSkills`, `safeHttpUrl`.
- `data.ts`: the pack query and `api.skills.togglePack`.
- `AgentsPage.tsx`: the Built-in badge, Reset to default, "Restore built-in agents (N)".
- `PairEditor.tsx` and `logic.ts`: the "Lead instructions" textarea, its counter and `LEAD_INSTRUCTIONS_MAX`.

## Tests (no model is called)

- `tests/skills-packs.test.ts`: the pstack pack loads with its subfolders, LF endings, and from the source tree; the loader's rules (a broken pack is skipped, what a folder leaves out is said, a missing root, `TRB_PACKS_DIR`); seeding and the update rule; the HTTP list names the pack.
- `tests/skills-builtin.test.ts`: the five inline built-ins; seeded once; a deleted one stays deleted; yours is not overwritten; edits show as modified; reset and restore.
- `tests/agents-builtin.test.ts`: seeding; yours is kept; a deleted one stays deleted; the update rule; a skill or MCP server that is not installed is logged and not thrown; reset; claiming a name; the five agents' texts and skill lists, and the brief's rules.
- `tests/pairs.test.ts`: the recipes create valid pairs; the preamble placement; the length rule and trimming; a recipe copies its brief; a missing agent gives the restore message; each recipe is a six-head pair on an xhigh Claude lead.
- `tests/practices.test.ts`: the pstack pack (at most eight rules, the linked skills); enabling writes the heading, rules and skill lines; disabling removes them. It runs on the scripted `fake` engine.
- `tests/web/settings.test.ts`: the pair editor's lead-instructions rule.
- `tests/skill-packs-api.test.ts`: the HTTP list and its counts, switching a pack off and on, 404 and 400, a skill of yours is not counted, a deleted pack skill is not switched on; the CLI `trb skill packs` and `trb skill pack <id> on|off`.
- `tests/web/skillsui.test.ts`: the pack sections (the flat list excludes pack skills, the titles and counts, a search keeps only the packs it finds in, and `packActions`).
- `tests/pstack-integration.test.ts`: every skill a built-in agent, the pstack practice pack or the lead text names is shipped; every role agent in the two recipes is a built-in agent; the adapter ships with the pack and is not hidden from the model; and on an empty home, seeding the skills and then the agents keeps each agent's skills list, and both recipes build through `fromCookbook`. It does not start the daemon or a run, and does not check the adapter's role lines against the recipes.

## Recipes (as merged)

Both recipes have a claude-opus-5-5 lead at xhigh, `max_heads` 6, and the same lead text. Each role carries its own instruction line.

| role | agent | pstack (Claude) | pstack (Claude + Codex) |
|---|---|---|---|
| lead | none | claude, claude-opus-5-5, xhigh | same |
| explorer | pstack-explorer | claude, claude-sonnet-5-5, medium | same |
| architect | pstack-architect | claude, claude-opus-5-5, high | same |
| builder | poteto-agent | claude, claude-sonnet-5-5, high | codex, default, high |
| verifier | pstack-verifier | claude, claude-opus-5-5, high | same |
| cleaner | comment-sicko | claude, claude-sonnet-5-5, medium | same |

The Codex recipe differs from the Claude one only in the builder's engine and model. Both builders run at high effort.

## Not built (planned)

- `trb pair add|edit --lead-instructions`.
- `trb agent restore` and `trb agent reset <name>`.
- Refusing a head whose role's agent was deleted, in `src/sessions/manager.ts` (`createChild`).
- The lead text's FAIL rule and PASS-only rule, in `PSTACK_LEAD`.
- A "missing skill" marker on the Agents page.
- Copying non-text files as bytes. Today they are logged and not shipped.
- The vendor script's `--dry-run` and `--commit` options, and a report of changed files.
