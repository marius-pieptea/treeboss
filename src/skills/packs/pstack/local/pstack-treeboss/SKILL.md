---
name: pstack-treeboss
description: "How to run pstack (poteto-mode and its skills) inside treeboss: where the skill files are, how pstack's Cursor names map to treeboss heads, roles and tools, and which steps treeboss skips. Read it before following any pstack playbook."
---

# pstack in treeboss

pstack was written for Cursor. Read this page before you follow any pstack playbook, and use the names below in place of Cursor's.

## a. Where pstack lives

For each turn, treeboss makes the enabled skills visible to the engine: linked into the workspace's skills folder by default, or copied when the `skills_link` setting is off. The stored copies are in `<trb home>/skills/<name>/`, which is `~/.treeboss/skills/` by default.

| Engine | Skills folder |
| --- | --- |
| Claude Code | `.claude/skills/` |
| Codex, Antigravity | `.agents/skills/` |
| Cursor Agent | `.cursor/skills/` |
| Grok | `.grok/skills/` |
| OpenCode | none: a prompt index lists each skill with its path |

Most pstack skills set `disable-model-invocation`, so the model does not pick them on its own. Read a skill's `SKILL.md` by its path, for example `.claude/skills/poteto-mode/SKILL.md`. The operator can still start any skill by typing `/<name>` at the start of a message.

## b. Who is who

- The Hydra pair's lead is the chat that receives `/poteto-mode`. It runs the playbook.
- Heads are pstack's subagents. The lead opens each one with `subagent_create`, and each is a child session with its own brief.
- In a pair in `roles` mode, every head names a role. A role sets the head's engine, model, effort and standing instructions. It can also name a built-in agent, which runs the head with that agent's instructions and skills. `subagent_create` refuses a role the pair does not have, and says which ones it has.

A pstack pair is one made from the `pstack-claude` or `pstack-claude-codex` recipe. Its five roles run as pstack's own agents, which treeboss ships:

| pstack's subagent | Role | Runs as |
| --- | --- | --- |
| explorer: how, why and recall explorers | `role: explorer` | `agent: pstack-explorer` |
| architect and arena runners | `role: architect` | `agent: pstack-architect` |
| poteto-agent and generalPurpose code delegates | `role: builder` | `agent: poteto-agent` |
| independent verifiers, interrogate and swarm gauntlets. Never the head that wrote the code | `role: verifier` | `agent: pstack-verifier` |
| comment-sicko, no-comments and unslop passes | `role: cleaner` | `agent: comment-sicko` |

A generalPurpose subagent takes the role its job calls for: `role: builder` for code, `role: verifier` for a check or a review, `role: explorer` for a read-only probe.

In any other roles pair, the lead brief lists each role with its label, its agent and what it is for: pick from that list. `subagent_create` also resolves a pstack or preset name to the pair's role when exactly one role matches it: `role: explorer` finds the role that runs `pstack-explorer`, and `role: worker` finds the role labelled Worker, whatever its id. Otherwise use the closest preset the pair has. `subagent_create` names the pair's roles when it refuses one:

| pstack's subagent | Closest preset |
| --- | --- |
| explorer | `role: scout`, read-only by its standing instructions |
| architect and arena runners | `role: architect` if the pair has one; otherwise write the candidates yourself and say so in one line (see d) |
| poteto-agent and generalPurpose code delegates | `role: worker` |
| verifier, interrogate and swarm gauntlets | `role: tester` for checks you can run, `role: reviewer` for a diff |
| comment-sicko, no-comments and unslop passes | `role: refactorer` |

Outside a pair, use the engine's own subagent tool instead. A head can run as any agent by name: pass it as `agent`. An operator makes an agent with `trb agent add`.

The vendored `poteto-help` skill still names `/setup-pstack` and `/make-bot-ui`, which treeboss does not ship: the pair's roles set the models.

## c. Name map: Cursor to treeboss

| Cursor (pstack) | treeboss |
| --- | --- |
| `Task` tool | `subagent_create` with `brief`. In a `roles` pair, also pass `role`. Outside a pair you may use the engine's own subagent tool instead. |
| `subagent_type: poteto-agent` | `role: builder` in a pstack pair; `role: worker` in another roles pair. |
| `subagent_type: generalPurpose` | the role its job calls for (see b). |
| `readonly: true` | `role: explorer` in a pstack pair; `role: scout` in another roles pair. The brief says the head must not edit anything. `subagent_create` has no read-only switch, so when the head returns, check `git status` in its worktree and report any change. |
| `environment: "cloud"` | a head. Each head gets its own git worktree when the workspace is a git repo. |
| `environment: "local"` | `isolate: false`, which shares your workspace. |
| `run_in_background: true` | heads always run in the background. Collect them with `subagent_wait`: `mode: "any"` returns at the first finisher, and `mode: "all"`, the default, waits for every head. |
| `resume` | `subagent_send` with the head's `id` and `message`. The head resumes with its brief and its previous answer. |
| model slugs, effort, `pstack-models.mdc` | the pair's role config sets the engine, model and effort. Inside a pair, do not pass an engine or model the pair does not offer: it is refused. |
| `AskQuestion` | ask in your reply. |
| todolist | the engine's own todo tool. If it has none, keep the list in your reply. |
| `.cursor/rules/*.mdc` | `AGENTS.md` and `CLAUDE.md`. Practice packs write their managed block there. |
| PR tool | `trb pr create <session>`, or `gh pr create`. |
| `/loop` and hourly ticks | `trb schedule add "<name>" --cron "0 * * * *" --kind prompt -p "<prompt>"`. For a spec's tasks, `trb autopilot start`. |

## d. Skipped steps

When a step needs something treeboss does not have, write one line in your reply in this form, then go on to the next step. Do not stop, ask or retry. If a later step needs what the skipped one made, such as a URL, leave a placeholder and name it in the line.

- Skipped in treeboss: Bugbot (unless the repo runs it through `gh`). It is Cursor's hosted reviewer, and treeboss does not start or wait for it.
- Skipped in treeboss: Cursor Automations and benny. They are Cursor's own automations. Use `trb schedule` instead.
- Skipped in treeboss: Origin. It is a forge CLI, like `gh`. Use `trb pr` or `gh`.
- Skipped in treeboss: /deslop. It belongs to cursor-team-kit, which treeboss does not ship. Use `unslop`, then `no-comments`.
- Skipped in treeboss: control-ui and control-cli. They are cursor-team-kit skills for driving a UI and a CLI. Use treeboss's browser tools (`browser_*`) or computer tools (`computer_*`), or the project's verification skill.
- Skipped in treeboss: create-skill. Write the `SKILL.md` directly in the skill's folder.
- Skipped in treeboss: /setup-pstack. The pair's role config sets the models.
- Skipped in treeboss: the worktree-cleanup playbook. treeboss finalises and removes a head's worktree when the head is closed.
- Skipped in treeboss: reading Cursor transcripts in recall and automate-me. Use treeboss session history: `trb ls`, `trb show <id>` and `trb logs <id>`.

## e. Pause rules

Stop and ask the operator before you:

- force-push to a shared branch;
- deploy;
- delete data;
- message a customer.

## f. Credit

The name map is adapted from pstack's `docs/harness/claude-code.md`, by Lauren Tan, MIT. For a Claude Code session that runs pstack without a Hydra pair, read `references/claude-code-adapter.md`.
