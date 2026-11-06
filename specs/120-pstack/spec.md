# Feature Specification: pstack in the core

**Feature**: `120-pstack`
**Status**: Merged on main. Open: T027 (bun test on a POSIX or CI machine)
**Input**: Cursor's pstack plugin (Lauren Tan, MIT, v0.15.36: "if you want to go fast, go deep first") built into treeboss, with nothing to install. Its skills ship as a built-in pack. Five built-in agents run its team, two Hydra pair recipes set up the team, a practice pack writes its principles into AGENTS.md and CLAUDE.md, and an adapter maps its Cursor-only names onto treeboss.

This spec describes the code on main. *(planned)* marks designed work that has not started.

## User Scenarios & Testing

### User Story 1 - Have pstack with no extra step (Priority: P1)

I install treeboss and start the daemon. The pstack skills and agents are already there, marked Built-in, the same way the design skills are. I install no plugin and run no setup command.

**Why this priority**: The team is only useful if it works on a fresh install. Any setup step would keep most operators from using it.

**Independent Test**: start the daemon on an empty `TRB_HOME`. `trb skill list` names the pstack skills, and Settings > Agents lists poteto-agent, comment-sicko, pstack-explorer, pstack-architect and pstack-verifier with the Built-in badge. Start the daemon again: nothing is added or replaced.

**Acceptance Scenarios**:

1. **Given** an empty `TRB_HOME`, **When** the daemon starts, **Then** the pack's skills and the five built-in agents exist.
2. **Given** the daemon has started before, **When** it starts again, **Then** no skill or agent is added, replaced or duplicated.
3. **Given** I deleted `pstack-verifier`, **When** the daemon restarts, **Then** it stays deleted, and Restore built-in agents brings it back.

### User Story 2 - Pick the pstack team and run a feature the pstack way (Priority: P1)

I add the `pstack (Claude)` recipe and start a run on a feature. The lead reads poteto-mode and pstack-treeboss, routes the task to one playbook, and hands each piece to the role that owns it: research to the explorer, design to the architect, code to the builder (poteto-agent), checks to the verifier and comment cleanup to the cleaner. The lead reviews every diff before it merges.

**Why this priority**: This is the feature. Skills alone are not a team. The pair binds each role to its agent and gives the lead its instructions.

**Independent Test**: with the scripted engine, which calls no model, add the recipe and start a run on the pair. The lead's first-turn preamble carries the pair's lead instructions, and a head opened in the builder role runs as poteto-agent with the skills in that agent's list. `tests/pstack-integration.test.ts` covers the part that needs no run. On an empty home it seeds the skills and then the agents, checks the five agents and their skills lists, and builds both recipes through `fromCookbook` with the recipe's lead instructions and role agents. It does not start a run. The preamble is covered in `tests/pairs.test.ts`, and a head that runs as its role's agent in `tests/agents.test.ts`, on a custom pair and not on a pstack recipe. *(planned: a run on the pstack pair with a builder head, a second start that adds nothing, a real daemon start, `trb pair recipes`, and a check that the adapter's role lines match the recipes' roles.)*

**Acceptance Scenarios**:

1. **Given** the `pstack (Claude)` pair, **When** a lead turn starts, **Then** its preamble carries the pair's lead instructions as "How this pair works:", after the fan-out and collect rules.
2. **Given** a head opened in the builder role, **When** it starts, **Then** it runs as poteto-agent with that agent's skills list.
3. **Given** I deleted `poteto-agent`, **When** I apply the `pstack (Claude)` recipe, **Then** it is refused with a message that names the recipe, the role and the agent, and says to restore built-in agents in Settings > Agents. No pair is created.

### User Story 3 - Verify with a model from another family (Priority: P2)

I add `pstack (Claude + Codex)`. The builder runs on Codex, and the verifier runs on Claude Opus, a different model family from the builder. The split follows pstack's own: code goes to a fast non-Claude model, and judgment goes to Claude Opus. The verifier's reply starts with PASS, PASS+NOTES or FAIL.

**Why this priority**: Cross-family verification is what pstack's review relies on, and only a harness that runs several engines can provide it. The Claude-only team already works, so this is P2.

**Independent Test**: read both recipes as data. They differ only in the builder's engine and model, and the verifier's instructions require the verdict line.

**Acceptance Scenarios**:

1. **Given** the Claude + Codex recipe, **When** I read its roles, **Then** the builder is on codex (default model, high effort), the verifier is on claude-opus-5-5 at high effort, and the other four roles match the Claude recipe.
2. **Given** a verifier's reply, **When** I read its first line, **Then** it is PASS, PASS+NOTES or FAIL.

### User Story 4 - Turn on the principles pack for a workspace (Priority: P2)

I run `trb practices enable pstack`. Eight pstack rules go into the practices block of AGENTS.md, mirrored into CLAUDE.md, and the block names nine principle skills. Every agent in the workspace reads them before it writes code. Disabling the pack removes the block.

**Why this priority**: The rules reach every agent in the workspace, not only the team. The team works without them, so this is P2.

**Independent Test**: in a workspace with my own AGENTS.md text, enable `pstack`. The practices block has eight rules and nine skill lines, and my text is unchanged. Disable it: the block is gone and my text is still the same.

**Acceptance Scenarios**:

1. **Given** a workspace with my own AGENTS.md text, **When** I enable `pstack`, **Then** only the practices block is written.
2. **Given** `pstack` is on and one of its principle skills is not installed, **When** the block is written, **Then** that skill's line still reads `Use the X skill if available.`, as the other practice packs do.

### User Story 5 - Re-sync pstack from upstream (Priority: P3)

A maintainer checks out a newer `cursor/plugins` and runs `bun scripts/vendor-pstack.ts <checkout>`. The script replaces the listed skill folders, minus the excluded files, and the LICENSE, and writes the version and commit into pack.json. It warns about upstream folders that the list does not name, and about listed skills that are gone upstream, so the maintainer can decide. It never touches `local/`. Operators get the new text on their next start, unless they edited their copy.

**Why this priority**: Upstream changes often, but the pack works at its pinned commit without a re-sync.

**Independent Test** (`tests/vendor-pstack.test.ts`): run the script against a fixture upstream folder with no network. The listed skill folders and the LICENSE are replaced, pack.json has the new version and commit, and a second run leaves the same files.

**Acceptance Scenarios**:

1. **Given** an upstream checkout with a changed skill, **When** I run the script, **Then** that skill's files are replaced with the upstream text, with LF line endings.
2. **Given** an upstream skill that pack.json's list does not name, **When** I run the script, **Then** it warns that the skill is not shipped and names it.
3. **Given** a checkout whose `pstack/plugin.json` names another plugin, **When** I run the script, **Then** it stops before it writes anything.

### Edge Cases

- I edited a pstack skill and a newer version ships: my copy is kept. Settings > Skills shows it as built-in, edited, and the start-up log names it. Reset puts the shipped text back.
- I deleted a pstack skill or agent: it stays deleted through upgrades and restarts. Restore built-in skills or Restore built-in agents brings it back.
- My own skill has the same name as a pack skill (`how`, for example): trb does not overwrite it, and the pack's copy is not installed.
- A re-sync drops a skill from pack.json's list: it is no longer loaded, and its installed copy is removed on the next start if the operator never edited it. An edited copy is kept and shown as retired (FR-007).
- A recipe's agent is deleted after its pair exists: the pair stays as it is, and head creation keeps today's behavior, so the head opens without that agent's instructions. Refusing that head is a planned follow-up.
- A built-in agent names a skill that is not installed, for example one I deleted: the agent is seeded without it, and a start-up log line names the skill. A built-in agent is never refused at start.
- A built-in agent follows the skills it can use: when one of them is installed later, an unedited copy picks it up on the next start. An edited copy is kept.
- The role id `architect` is also a library role. Every recipe role carries its own instruction line, so the library text is not added to the head.
- Lead instructions over 2,000 characters are refused on save, with the count. The length is counted as sent, before trimming.
- Read-only is by instruction. treeboss has no per-agent read-only switch, and a Hydra run is not sandboxed (see the safety model in the README). pstack-explorer is told not to change anything and to end by checking that git status is clean. The lead does not merge its branch. A hard read-only guarantee is not promised.
- The Claude-only team has no cross-family check: its builder and verifier are both Claude models. The Claude + Codex team has one: the builder is Codex and the verifier is Claude Opus. The lead and the verifier are both Claude Opus.
- A file in a skill folder that is not text is not shipped, and the load logs its name. Text is stored with LF line endings.
- The Cursor-only parts are named in the adapter's skip list: Bugbot, Cursor Automations and benny, Origin, /deslop, control-ui and control-cli, create-skill, /setup-pstack, the worktree-cleanup playbook, and reading Cursor transcripts. The reply names each one as skipped, with its reason.
- The five built-in agents carry no engine, model or effort: the pair's role config decides.
- The adapter's `references/claude-code-adapter.md` opens with an attribution comment and then carries upstream's Claude Code page. Its text was not byte-compared with upstream.

## Requirements

### Functional Requirements

- **FR-001**: The pstack skill folders are copied from upstream's `pstack/skills/` into `src/skills/packs/pstack/skills/`, with upstream's `LICENSE` at `src/skills/packs/pstack/LICENSE`. Text is stored with LF line endings, the only change from upstream. `scripts/vendor-pstack.ts` is the only writer, and a test enforces it (FR-004). The pack folder holds 161 files and 696,623 bytes, including LICENSE, pack.json and the adapter.
- **FR-002**: `src/skills/packs/pstack/pack.json` records `id` (`pstack`), `title`, `version` (`0.15.36`), `author` (`Lauren Tan`), `license` (`MIT`), `upstream` (the cursor/plugins URL), `commit` (`c742dd61706fbacc1b95f1a20b7b988cf096ce6c`), `skills` (56 names), `exclude` (`["statechart/scripts/test/**"]`) and `local` (`["pstack-treeboss"]`). `hashes` (a SHA-256 for every file under the pack's `skills/` and its LICENSE, written by the vendor script).
- **FR-003**: The skills list names 56 of upstream's 58 skills. `setup-pstack` and `make-bot-ui` are left out. The `exclude` glob drops statechart's test corpus, 376 files under `scripts/test`, and none of it is on disk. None of the Slack or Cursor Automations skills, nor any cursor-team-kit skill, is among the 58 upstream folders. So 57 pack skills ship: the 56 from pstack and the adapter `pstack-treeboss`.
- **FR-004**: A test MUST fail when a vendored file differs from its recorded hash, and when an excluded skill or the statechart corpus is present.
- **FR-005**: `NOTICE` carries a pstack entry. It credits pstack 0.15.36 with its URL, says the agents and recipes adapt its text, and reproduces the MIT license with its copyright line. The pinned commit is in pack.json, not in NOTICE. The root `LICENSE` (AGPL-3.0) is unchanged.
- **FR-006**: The pack's skills are seeded as built-ins on daemon start, through the same store and the same list as the five inline built-ins (design-discovery, design-critique, brand-extract, clone-from-evidence and product-teardown, in `src/skills/builtin.ts`). That list is `builtinSkills()`: the five inline built-ins, then the pack skills. Restore built-in skills brings back a missing one, Reset puts the shipped text back, and the Built-in badge shows. The loader is `src/skills/packs.ts`. `packsRoot()` reads `TRB_PACKS_DIR` when it is set and exists, then `src/skills/packs` beside the source, then `packs/` in the folder above the binary's folder. `loadPacks()` reads each folder with a valid pack.json, loads each skill its `skills` list names from `skills/`, and each skill its `local` list names from `local/`. It applies the `exclude` globs as it reads. A broken pack is logged and skipped.
- **FR-007**: The update rule. `<home>/builtin-skills.json` holds `seeded` (the names seeded so far) and `hashes` (for each name, the digest of the text trb last wrote). On each start, for each built-in, the rule is:
  1. A name not yet seeded is marked seeded and installed, unless a skill of yours has the name. Yours then stays yours.
  2. A built-in whose skill is deleted, or was replaced by a skill of yours, is left alone. A deleted one stays deleted until Restore.
  3. A copy whose recorded digest equals the shipped text is left as it is.
  4. A copy that already matches the shipped text is left as it is, and its digest is recorded.
  5. A copy whose digest equals its recorded digest is unedited: it is rewritten with the shipped text.
  6. A copy that matches neither is edited: it is kept. The start-up log names it ("kept your edits ... reset one to take the new text"), and Settings > Skills shows it as built-in, edited.
  7. A state file from before `hashes` existed adopts a copy only when that copy already is the shipped text.
  The rule covers the five inline built-ins as well as the pack's skills. A seeded name that its source no longer lists is retired: its copy is removed when it is unedited, and kept and reported as retired (`builtinStatus`) when edited. The source is recorded in the state file as `origin` (`inline` or the pack id). A name whose pack failed to load (a missing folder or a broken pack.json), or whose origin was never recorded, is never retired, because the list lost it and trb did not stop shipping it.
- **FR-008**: The adapter `pstack-treeboss` is at `src/skills/packs/pstack/local/pstack-treeboss/SKILL.md`, with `references/claude-code-adapter.md` beside it. It is treeboss's text, outside the vendored `skills/` folder, and it has no `disable-model-invocation` in its frontmatter. Its name map covers Task, `readonly`, cloud agents, model slugs and effort, AskQuestion, todolist, `/loop` and hourly ticks, and the skip list in Edge Cases. Its role map names the recipe roles explorer, architect, builder, verifier and cleaner, each with its built-in agent. The library roles scout, worker, tester, reviewer and refactorer appear only as the fallback for any other roles pair.
- **FR-009**: The five built-in agents are data in `src/agents/pstack.ts`, shipped by `src/agents/builtin.ts`. None is a file under the pack folder. Each has an explicit skills list (null, which means every enabled skill, is used by no built-in), no engine, model or effort, and an instruction text that ends with "Adapted from pstack by Lauren Tan (MIT)."
  - **poteto-agent** (builder): reads poteto-mode in full before any work. Skills: poteto-mode, pstack-treeboss, tdd, typescript-best-practices, blast-radius, unslop, technical-writing, and the 24 principle skills.
  - **comment-sicko** (cleaner): lists the comments to cut, and deletes them only when its brief asks. Skills: how, why, no-comments, unslop, pstack-treeboss.
  - **pstack-explorer**: read-only by instruction, with cited findings. Skills: how, why, recall, blast-radius, teach, in-your-own-words, sharpen, pstack-treeboss.
  - **pstack-architect**: design only, with at least two distinct candidates and one recommendation written with the rationale template. Skills: architect, arena, figure-it-out, statechart, pstack-treeboss, and 11 principle skills.
  - **pstack-verifier**: independent of the author. Its first line is PASS, PASS+NOTES or FAIL. Skills: interrogate, swarm, blast-radius, benchmark-checklist, create-verification-skill, maintain-verification-skill, create-formal-verification-skill, maintain-formal-verification-skill, statechart, pstack-treeboss, and 5 principle skills.
- **FR-010**: Two pair recipes are in `PAIR_COOKBOOK` (src/hydra/pairs.ts): `pstack-claude`, titled `pstack (Claude)`, and `pstack-claude-codex`, titled `pstack (Claude + Codex)`. Both are roles-mode pairs with `max_heads` 6, a claude-opus-5-5 lead at xhigh effort, and the same lead instructions. Their roles are explorer (pstack-explorer), architect (pstack-architect), builder (poteto-agent), verifier (pstack-verifier) and cleaner (comment-sicko). In the Claude recipe the explorer and cleaner are on claude-sonnet-5-5 at medium, the architect and verifier on claude-opus-5-5 at high, and the builder on claude-sonnet-5-5 at high. The Codex recipe differs only in the builder, which runs on codex (default model, high effort). So the builder and the verifier come from different model families.
- **FR-011**: Every role of a recipe carries its own instruction line (`PSTACK_ROLE_NOTE`), so the library's text for an id such as `architect` is never added to a head.
- **FR-012**: A pair takes optional `lead_instructions`, a text of at most `LEAD_INSTRUCTIONS_CHARS` (2,000) characters, counted before trimming. It is trimmed when stored, and blank means none. Create and update both check it (`HydraPairs`), so the pair routes and the pair editor share the rule. The `lead_instructions` column is added by `addColumn` in `src/db.ts`. The lead's per-turn preamble (`leadTurnPreamble`) carries it as "How this pair works:", after the fan-out and collect rules and before the list of heads still open. The pair editor (`web/src/features/settings/PairEditor.tsx`) has a "Lead instructions" textarea with an "n / 2,000" counter. *(planned: `trb pair add|edit --lead-instructions`.)*
- **FR-013**: The shared lead text (`PSTACK_LEAD`) tells the lead to read poteto-mode in full and pstack-treeboss by path, and to read each principle it applies. It tells the lead to route the task to one playbook and copy its steps into the todo list, keeping a skipped step as `skip: <reason>`. It names the five pstack roles and what each head does, to brief each head with file pointers, the named data shape and the success criteria, and to open a fresh head per unit. It tells the lead to own every diff, reviewing it and running the checks before it merges, and to pause only for irreversible actions: force-push, deploys, data deletion and customer messages. *(planned: the text does not yet say that FAIL goes back to the builder, or that a change ships only on PASS or PASS+NOTES.)*
- **FR-014**: Applying a recipe is refused when one of its roles names an agent that is not installed. `fromCookbook` checks the roles before it creates the pair, and every route and command that applies a recipe goes through it: `POST /api/pairs` with `recipe`, and `trb pair add --recipe`. The message names the recipe, the role and the agent, and says to restore built-in agents in Settings > Agents. Nothing is created. Head creation (`subagent_create`, `trb spawn -r`) is unchanged: a head whose role's agent was deleted opens without that agent's instructions. *(planned: refusing that head.)*
- **FR-015**: The practice pack `pstack` (title "pstack principles") applies to every stack (`any`). Its eight rules are plain text, it names nine principle skills (prove-it-works, fix-root-causes, attack-the-premise, test-behavior-not-implementation, sequence-verifiable-units, model-the-domain, minimize-reader-load, subtract-before-you-add, migrate-callers-then-delete-legacy-apis), and it carries no mechanical check. It is off in every workspace until enabled.
- **FR-016**: `bun scripts/vendor-pstack.ts <checkout>` takes one argument, a checkout of cursor/plugins, or `--hashes-only`, which rewrites only the `hashes` in pack.json from the files on disk and needs no checkout. `--pack <folder>` names another pack folder. Its usage line reads `usage: bun scripts/vendor-pstack.ts <path-to-cursor-plugins-checkout>  |  --hashes-only   [--pack <pack-folder>]`. It requires an existing pack.json with a valid skills list, and it refuses before it writes anything if the checkout's `pstack/plugin.json` does not name pstack, if HEAD is not a commit, or if `pstack/skills` or `pstack/LICENSE` is missing. It copies every listed folder that exists upstream, file by file, minus the files the `exclude` globs match. It replaces the skill folders under `src/skills/packs/pstack/skills`, copies the LICENSE, keeps the executable bit that git records, stores text with LF line endings, and refuses symlinks. It writes `version`, `commit` and `hashes` into pack.json and keeps the other fields, including `exclude` and `local`. It warns about upstream folders the list does not name, and about listed skills that are gone upstream. It ends with a summary line: the version, the commit, the skill count, the file count with the excluded count, and the executable count. It never touches `local/`, makes no network call and copies no agent definitions. It does not check that the checkout is clean, so use a clean one. *(planned: a `--dry-run` flag, a `--commit` option, and a report of changed files. None exists.)*
- **FR-017**: The routes, CLI and UI for built-ins and packs are built.
  - `GET /api/skills` gives each skill `builtin`, `modified` and `pack`, and `missingBuiltins`. `POST /api/skills/restore-builtins` and `POST /api/skills/:name/reset` are in `src/daemon/routes/x_settings.ts`.
  - `GET /api/skills/packs` lists each pack with its manifest fields, its skills, and how many are installed and on. `POST /api/skills/packs/:id/enabled` takes `{enabled: boolean}`: 400 when the value is not a boolean, 404 for an unknown pack. Both are in `x_settings.ts`, backed by `src/skill-packs.ts`. A pack's installed skills are the store records that are built-ins of that pack. A skill of yours with the same name is neither counted nor switched, and a deleted pack skill is not switched back on.
  - CLI: `trb skill packs` lists the packs, and `trb skill pack <id> on|off` switches a pack's installed skills.
  - `GET /api/agents` gives each agent `builtin` and `modified`, and `missingBuiltins`. `POST /api/agents/restore-builtins` and `POST /api/agents/:name/reset` are in `src/daemon/routes/agents.ts`.
  - Settings > Skills shows one collapsible section per pack, collapsed by default. Each shows its title, count, version, license, author and upstream link, with Enable all and Disable all. A search opens the packs it matches, and selecting a pack skill opens its pack. A pack skill's row carries the pack's badge. Settings > Agents shows a Built-in badge ("Built-in", or "Built-in, edited"), a Reset to default button, and "Restore built-in agents (N)" when some are missing.
  - *(planned)*: `trb agent restore` and `trb agent reset <name>`; a "missing skill" marker on the Agents page.
- **FR-018**: No pstack test calls a model. These files start no engine: `tests/skills-packs.test.ts`, `tests/skills-builtin.test.ts`, `tests/agents-builtin.test.ts`, `tests/pairs.test.ts`, `tests/practices.test.ts`, `tests/web/settings.test.ts`, `tests/skill-packs-api.test.ts` and `tests/web/skillsui.test.ts`. `tests/practices.test.ts` runs its turns on the scripted `fake` engine. `tests/skill-packs-api.test.ts` runs the CLI as a subprocess.
- **FR-019**: Status digests are memoized. A copy's digest is remembered with the stat of its files (name, size, modified and changed times), and a copy with a file written in the last two seconds is read again, because its timestamps may still move. The shipped digest of each built-in is computed once per process.

### Key Entities

- **Skill pack**: id `pstack`, version, upstream commit, license, the include list (`skills`), the `exclude` globs, the `local` list, and the skill folders under `skills/` and `local/`.
- **Built-in skill**: name, description, text files, and the pack it ships in (absent for the five inline built-ins). Built in when its store record has the built-in source.
- **Built-in agent**: name, title, description, instructions, a skills list and an MCP list (null means all enabled), and a fingerprint in `<home>/builtin-agents.json`. It is built in when its name is recorded there with a fingerprint. A null entry means the name is yours.
- **Team recipe**: id, title, tagline, lead engine, model and effort, lead instructions, max heads, and roles (each with an engine, model, effort, agent and instruction line).
- **Lead instructions**: text on a pair, at most 2,000 characters counted before trimming, shown in the lead's per-turn preamble.

## Success Criteria

- **SC-001**: `bun test tests/skills-packs.test.ts tests/skills-builtin.test.ts tests/agents-builtin.test.ts tests/pairs.test.ts tests/practices.test.ts tests/web/settings.test.ts tests/skill-packs-api.test.ts tests/web/skillsui.test.ts` passes. None of these files starts a model.
- **SC-002**: `bun test` and `bun run typecheck` pass on main.
- **SC-003**: On an empty `TRB_HOME`, the first daemon start adds the pack's skills and the five agents, and the second start adds nothing. *(The lead runs this; T028.)*
- **SC-004**: `trb pair recipes` lists `pstack-claude` and `pstack-claude-codex`, and the two differ only in the builder's engine and model.

## Assumptions

- pstack is MIT licensed. The LICENSE in the pack folder and the MIT text in NOTICE carry the copyright line and the permission notice.
- The adapter's name map is the part of Cursor's mechanisms that treeboss maps. Its role map names the recipes' roles, so a lead that follows it opens its first head in a role the pair has.
- Read-only is by instruction, not by sandbox (see Edge Cases).
- The packs ship beside the daemon in the desktop app: `desktop/stage.ts` copies `src/skills/packs` to `stage/packs`, `desktop/electron-builder.yml` places it in the app's resources as `packs/` (mac and win), and `desktop/main.cjs` passes `TRB_PACKS_DIR`.
- The five inline built-in skills follow the same update rule as the pack's skills (FR-007). They are no longer seed-once.
- Cost. Pack skills are enabled by default. With `default_skills` at its default, `all`, a session with no skills list of its own gets every enabled skill, pack skills included, linked into its workspace for each turn (copied when `skills_link` is off). On an engine with no skills folder, the built-ins are listed in the prompt instead, one line each. The 56 upstream skills set `disable-model-invocation: true`, so Claude does not load their descriptions. The adapter does not set it, and engines without that flag may list the skills. Disable all on the Skills page, or `trb skill pack pstack off`, turns the pack's installed skills off.
- `default_skills` is `all` in `src/settings.ts`. The comment on `defaultSkillNames` in `src/skills/store.ts` says the whole library is never the default. That comment is out of date.
- The team's quality depends on the models the operator picks. The recipes set defaults only.
- Planned next, not in this feature: a `trb pair add|edit --lead-instructions` flag and `trb agent restore|reset`; refusing a head whose role's agent was deleted; the lead text's FAIL and PASS-only rules; a "missing skill" marker on the Agents page; copying non-text files as bytes; the rest of the integration test, tests/pstack-integration.test.ts (a check that the adapter's role lines match the recipes' roles, a second start that adds nothing, and `trb pair recipes`); mapping pstack's autopilot-full, autopilot-stack and orchestrate playbooks onto treeboss autopilot runs; a review stage in the spec pipeline using interrogate and comment-sicko; using create-verification-skill output as treeboss verify commands; benny-style triage onto the signals loop; reflecting learnings into memory and practices.
